// src/modules/projects/projects.service.ts
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Projeto } from '../../entities/projeto.entity';
import { TenantDbManager } from '../tenant/tenant-db.manager';

@Injectable()
export class ProjectsService {
  constructor(private tenantDb: TenantDbManager) { }

  private async getRepo(usuarioId: string): Promise<Repository<Projeto>> {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Projeto);
  }

  async findAll(usuarioId: string): Promise<Projeto[]> {
    const repo = await this.getRepo(usuarioId);
    return repo.find({
      where: { usuario_id: usuarioId },
      relations: ['videos'],
      order: { criado_em: 'DESC' },
    });
  }

  async findOne(usuarioId: string, id: string): Promise<Projeto> {
    const repo = await this.getRepo(usuarioId);
    const p = await repo.findOne({
      where: { id, usuario_id: usuarioId },
      relations: ['videos', 'videos.cortes'],
    });
    if (!p) throw new NotFoundException(`Projeto ${id} não encontrado`);
    return p;
  }

  async create(usuarioId: string, data: Partial<Projeto>): Promise<Projeto> {
    const repo = await this.getRepo(usuarioId);
    const projeto = repo.create({
      ...data,
      id: uuidv4(),
      usuario_id: usuarioId,
    });
    return repo.save(projeto);
  }

  async update(usuarioId: string, id: string, data: Partial<Projeto>): Promise<Projeto> {
    const p = await this.findOne(usuarioId, id);
    if (!p) throw new NotFoundException('Projeto não encontrado');

    const repo = await this.getRepo(usuarioId);
    await repo.update(id, data);
    return this.findOne(usuarioId, id);
  }

  async remove(usuarioId: string, id: string): Promise<void> {
    const p = await this.findOne(usuarioId, id);
    if (!p) throw new NotFoundException('Projeto não encontrado');

    const repo = await this.getRepo(usuarioId);
    await repo.delete(id);
  }
}
