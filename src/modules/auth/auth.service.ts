// src/modules/auth/auth.service.ts
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Usuario } from '../../entities/usuario.entity';
import { AuthLoginDto } from './dto/auth-login.dto';
import { AuthRegisterDto } from './dto/auth-register.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(Usuario) private usuariosRepo: Repository<Usuario>,
    private jwtService: JwtService,
    private dataSource: DataSource,
  ) {}

  async register(dto: AuthRegisterDto) {
    const existingEmail = await this.usuariosRepo.findOne({
      where: { email: dto.email },
    });

    if (existingEmail)
      throw new ConflictException('Esse e-mail já está cadastrado');

    const senhaHash = await bcrypt.hash(dto.password, 12);

      // Todo usuário recém criado ganha 30 créditos grátis (teste)
      const usuario = this.usuariosRepo.create({
        nome: dto.nome,
        email: dto.email,
        senha_hash: senhaHash,
        creditos_disponiveis: 30, // 30 min grátis para teste
        plano: 'free',
        status: 'active',
      });

    await this.usuariosRepo.save(usuario);

    const secret = process.env.SECRET_TENANT;

    // Provisiona um novo banco de dados para este usuário
    try {
      const dbName = `${secret}${usuario.id.replace(/-/g, '_')}`;
      await this.dataSource.query(`CREATE DATABASE "${dbName}"`);
      this.logger.log(`Created database ${dbName} for user ${usuario.id}`);
    } catch (err) {
      this.logger.error(
        `Could not create database for user ${usuario.id}: ${err.message}`,
      );
      // Geralmente prossegue mesmo se falhar (ex: já existe) mas registra o erro
    }

    const payload = {
      sub: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
    };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        creditos_disponiveis: usuario.creditos_disponiveis,
        plano: usuario.plano,
      },
    };
  }

  async login(dto: AuthLoginDto) {
    const user = await this.usuariosRepo.findOne({
      where: { email: dto.email },
    });

    if (!user) throw new UnauthorizedException('Credenciais inválidas');

    if (user.status !== 'active')
      throw new UnauthorizedException('Conta inativa ou suspensa');

    const valid = await bcrypt.compare(dto.password, user.senha_hash);
    if (!valid) throw new UnauthorizedException('Credenciais inválidas');

    const payload = { sub: user.id, email: user.email, nome: user.nome };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        creditos_disponiveis: user.creditos_disponiveis,
        plano: user.plano,
      },
    };
  }

  async getMe(userId: string) {
    const user = await this.usuariosRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    return {
      id: user.id,
      nome: user.nome,
      email: user.email,
      creditos_disponiveis: user.creditos_disponiveis,
      plano: user.plano,
      status: user.status,
    };
  }

  async updateProfile(userId: string, data: { nome?: string; email?: string }) {
    const user = await this.usuariosRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    if (data.email && data.email !== user.email) {
      const exists = await this.usuariosRepo.findOne({
        where: { email: data.email },
      });
      if (exists)
        throw new ConflictException('E-mail já está em uso por outra conta');
    }

    await this.usuariosRepo.update(userId, data);
    return this.getMe(userId);
  }

  async updatePassword(
    userId: string,
    data: { currentPassword?: string; newPassword: string },
  ) {
    const user = await this.usuariosRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    if (data.currentPassword) {
      const valid = await bcrypt.compare(data.currentPassword, user.senha_hash);
      if (!valid) throw new UnauthorizedException('Senha atual incorreta');
    }

    const hashed = await bcrypt.hash(data.newPassword, 12);
    await this.usuariosRepo.update(userId, { senha_hash: hashed });
    return { success: true };
  }
}
