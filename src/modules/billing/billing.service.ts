import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Usuario } from '../../entities/usuario.entity';
import { CreditsService } from '../credits/credits.service';
import { PLANS, EXTRA_CREDITS } from './billing.constants';
import Stripe from 'stripe';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripe: Stripe;

  constructor(
    @InjectRepository(Usuario)
    private readonly usuarioRepo: Repository<Usuario>,
    private readonly creditsService: CreditsService,
    private readonly configService: ConfigService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY') || '';
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2024-04-10' as any,
    });
  }

  async createCheckoutSession(usuarioId: string, planId: string) {
    const user = await this.usuarioRepo.findOne({ where: { id: usuarioId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const plan = Object.values(PLANS).find(p => p.id === planId);
    if (!plan && !planId.startsWith('extra_')) {
      throw new BadRequestException('Plano inválido');
    }

    let lineItem: Stripe.Checkout.SessionCreateParams.LineItem;

    if (planId.startsWith('extra_')) {
      const amount = parseInt(planId.split('_')[1]);
      const extra = EXTRA_CREDITS.find(e => e.amount === amount);
      if (!extra) throw new BadRequestException('Opção de crédito extra inválida');

      lineItem = {
        price_data: {
          currency: 'brl',
          product_data: {
            name: `${extra.amount} Créditos Extras - Kurt Cut`,
          },
          unit_amount: Math.round(extra.price * 100),
        },
        quantity: 1,
      };
    } else if (plan) {
      lineItem = {
        price_data: {
          currency: 'brl',
          product_data: {
            name: `Plano ${plan.name} - Kurt Cut`,
          },
          unit_amount: Math.round(plan.price * 100),
          recurring: { interval: 'month' },
        },
        quantity: 1,
      };
    } else {
      throw new BadRequestException('Configuração de plano inválida');
    }

    const simulate = this.configService.get<string>('SIMULATE_BILLING') === 'true';
    const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost:5000';

    if (simulate) {
      this.logger.log(`[SIMULATION] Redirecting to internal checkout for user ${usuarioId}, plan ${planId}`);
      return { url: `${frontendUrl}/checkout?planId=${planId}` };
    }

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [lineItem],
      mode: planId.startsWith('extra_') ? 'payment' : 'subscription',
      success_url: `${frontendUrl}/dashboard?checkout=success`,
      cancel_url: `${frontendUrl}/upgrade?checkout=cancel`,
      customer_email: user.email,
      metadata: {
        usuarioId,
        planId,
      },
    });

    return { url: session.url };
  }

  async handleWebhook(signature: string, payload: Buffer) {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET') || '';
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException('Webhook Error');
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
    }
  }

  private async handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const metadata = session.metadata;
    if (!metadata) return;
    
    const usuarioId = metadata.usuarioId;
    const planId = metadata.planId;
    
    if (!usuarioId || !planId) return;

    if (planId.startsWith('extra_')) {
      const amount = parseInt(planId.split('_')[1]);
      await this.creditsService.addCredits(usuarioId, amount, `Compra de créditos extras (${amount})`);
    } else {
      const plan = Object.values(PLANS).find(p => p.id === planId);
      if (plan) {
        await this.usuarioRepo.update(usuarioId, {
          plano: planId,
          stripe_subscription_id: session.subscription as string,
          stripe_customer_id: session.customer as string,
        });
        await this.creditsService.addCredits(usuarioId, plan.credits, `Ativação do plano ${plan.name}`);
      }
    }
  }

  async cancelSubscription(usuarioId: string) {
    const user = await this.usuarioRepo.findOne({ where: { id: usuarioId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const simulate = this.configService.get<string>('SIMULATE_BILLING') === 'true';

    if (simulate) {
      this.logger.log(`[SIMULATION] Cancelling subscription for user ${usuarioId}`);
      await this.usuarioRepo.update(usuarioId, {
        plano: 'free',
        stripe_subscription_id: null,
        stripe_customer_id: null,
      });
      return { success: true };
    }

    if (user.stripe_subscription_id) {
      try {
        await this.stripe.subscriptions.cancel(user.stripe_subscription_id);
      } catch (err) {
        this.logger.error(`Stripe cancellation failed: ${err.message}`);
      }
    }

    await this.usuarioRepo.update(usuarioId, {
      plano: 'free',
      stripe_subscription_id: null,
    });

    return { success: true };
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    const user = await this.usuarioRepo.findOne({ where: { stripe_subscription_id: subscription.id } });
    if (user) {
      await this.usuarioRepo.update(user.id, {
        plano: 'free',
        stripe_subscription_id: null,
      });
      this.logger.log(`Subscription deleted for user ${user.id}`);
    }
  }

  async getSubscriptionDetails(usuarioId: string) {
    const user = await this.usuarioRepo.findOne({ where: { id: usuarioId } });
    if (!user) throw new NotFoundException();

    return {
      plan: user.plano,
      credits: user.creditos_disponiveis,
      expiresAt: user.plano_expira_em,
    };
  }

  async confirmSimulatedPayment(usuarioId: string, planId: string, paymentData: any) {
    this.logger.log(`[SIMULATION] Confirming payment for user ${usuarioId}, plan ${planId}. Method: ${paymentData.method}`);
    
    const plan = Object.values(PLANS).find(p => p.id === planId);
    
    if (planId.startsWith('extra_')) {
      const amount = parseInt(planId.split('_')[1]);
      await this.creditsService.addCredits(usuarioId, amount, `[SIMULADO] Compra de créditos extras (${amount}) via ${paymentData.method}`);
    } else if (plan) {
      await this.usuarioRepo.update(usuarioId, {
        plano: planId,
        stripe_subscription_id: `sub_mock_${Date.now()}`,
        stripe_customer_id: 'cus_mock_123',
      });
      await this.creditsService.addCredits(usuarioId, plan.credits, `[SIMULADO] Ativação do plano ${plan.name} via ${paymentData.method}`);
    } else {
      throw new BadRequestException('Plano inválido para simulação');
    }

    return { success: true };
  }
}
