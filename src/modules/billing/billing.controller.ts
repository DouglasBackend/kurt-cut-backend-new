import { Controller, Post, Get, Body, UseGuards, Request, Headers } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BillingService } from './billing.service';

@Controller('api/billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  async createCheckout(@Request() req, @Body('planId') planId: string) {
    return this.billingService.createCheckoutSession(req.user.id, planId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('subscription')
  async getSubscription(@Request() req) {
    return this.billingService.getSubscriptionDetails(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscription/cancel')
  async cancelSubscription(@Request() req) {
    return this.billingService.cancelSubscription(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('checkout/confirm-simulated')
  async confirmSimulatedPayment(@Request() req, @Body() body: any) {
    return this.billingService.confirmSimulatedPayment(req.user.id, body.planId, body.paymentData);
  }

  @Post('webhook')
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @Request() req: any,
  ) {
    // Note: Raw body is required for Stripe signature verification
    return this.billingService.handleWebhook(signature, (req as any).rawBody);
  }
}
