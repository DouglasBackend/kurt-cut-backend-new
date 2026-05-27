import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Usuario } from '../../entities/usuario.entity';

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    @InjectRepository(Usuario)
    private readonly usuarioRepo: Repository<Usuario>,
  ) {}

  private async getUserRepo(usuarioId: string) {
    return this.usuarioRepo;
  }

  /**
   * Retorna o saldo de créditos do usuário.
   */
  async getBalance(usuarioId: string): Promise<number> {
    const repo = await this.getUserRepo(usuarioId);
    const user = await repo.findOne({ where: { id: usuarioId } });
    return user?.creditos_disponiveis ?? 0;
  }

  /**
   * Verifica se o usuário tem créditos suficientes.
   * @param minutes — minutos de vídeo a processar
   * @returns créditos necessários (arredondado para cima)
   */
  async checkCredits(usuarioId: string, minutes: number): Promise<{ hasCredits: boolean; required: number; available: number }> {
    const required = Math.ceil(minutes);
    const available = Math.floor(await this.getBalance(usuarioId));
    return { hasCredits: available >= required, required, available };
  }

  /**
   * Desconta créditos do usuário.
   * @throws BadRequestException se insuficiente
   */
  async deductCredits(usuarioId: string, amount: number, reason: string): Promise<number> {
    const repo = await this.getUserRepo(usuarioId);
    const user = await repo.findOne({ where: { id: usuarioId } });
    if (!user) throw new BadRequestException('Usuário não encontrado');

    const cost = Math.ceil(amount); 
    if (user.creditos_disponiveis < cost) {
      throw new BadRequestException(
        `Créditos insuficientes. Necessário: ${cost}, disponível: ${user.creditos_disponiveis}`
      );
    }

    user.creditos_disponiveis = Math.floor(user.creditos_disponiveis - cost);
    await repo.save(user);
    this.logger.log(`[credits] ${usuarioId}: -${cost} créditos (${reason}). Saldo: ${user.creditos_disponiveis}`);
    return user.creditos_disponiveis;
  }

  /**
   * Adiciona créditos ao usuário (para compras, promoções, etc.)
   */
  async addCredits(usuarioId: string, amount: number, reason: string): Promise<number> {
    const repo = await this.getUserRepo(usuarioId);
    const user = await repo.findOne({ where: { id: usuarioId } });
    if (!user) throw new BadRequestException('Usuário não encontrado');

    user.creditos_disponiveis = Math.floor(user.creditos_disponiveis + amount);
    await repo.save(user);
    this.logger.log(`[credits] ${usuarioId}: +${amount} créditos (${reason}). Saldo: ${user.creditos_disponiveis}`);
    return user.creditos_disponiveis;
  }
}
