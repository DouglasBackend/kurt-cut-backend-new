import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Patch,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ClipsService } from './clips.service';
import { StorageService } from '../../common/storage/storage.service';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { CLIP_EXPORT_QUEUE, ClipJobType } from '../queue/queue.constants';
import * as path from 'path';

@Controller('api/clips')
@UseGuards(JwtAuthGuard)
export class ClipsController {
  constructor(
    private readonly clipsService: ClipsService,
    private readonly storageService: StorageService,
    @InjectQueue(CLIP_EXPORT_QUEUE) private exportQueue: Queue,
  ) {}

  /** Maps PT-BR entity fields to the English aliases the frontend expects */
  private mapClip(c: any) {
    if (!c) return c;

    const getUrl = (p: string) => {
      if (!p) return p;
      if (p.startsWith('http')) return p;

      let relativePath = p;
      if (p.includes('uploads/') || p.includes('uploads\\')) {
        const normalized = p.replace(/\\/g, '/');
        const idx = normalized.lastIndexOf('uploads/');
        // Extract only the part AFTER "uploads/"
        relativePath = idx !== -1 ? normalized.substring(idx + 8) : path.basename(p);
      }

      return this.storageService.getPublicUrl(relativePath);
    };

    return {
      ...c,
      title: c.titulo,
      description: c.descricao,
      start_time: c.tempo_inicio,
      end_time: c.tempo_fim,
      duration: c.duracao,
      viral_score: c.pontuacao_viral,
      score: c.pontuacao_viral,
      justification: c.justificativa,
      ai_reason: c.justificativa,
      file_path: getUrl(c.caminho_arquivo),
      output_path: getUrl(c.caminho_arquivo),
      thumbnail_path: getUrl(c.miniatura_caminho),
      subtitle_data: c.dados_legenda,
      dados_legenda: c.dados_legenda,
      aspect_ratio: c.proporcao_tela,
      created_at: c.criado_em,
      updated_at: c.atualizado_em,
    };
  }

  @Get()
  async findAll(@Query('videoId') videoId: any, @Request() req) {
    let vId = Array.isArray(videoId) ? videoId[0] : videoId;
    if (vId === 'null' || vId === 'undefined' || vId === '{videoId}') vId = undefined;
    if (vId && typeof vId === 'string' && vId.trim() === '') vId = undefined;
    const clips = await this.clipsService.findAll(req.user.id, vId);
    return clips.map((c) => this.mapClip(c));
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req) {
    const cid = id ? String(id).trim() : '';
    if (!cid || cid === 'null' || cid === 'undefined' || cid === '{id}' || cid === '{videoId}') {
      throw new BadRequestException('Invalid clip ID');
    }
    return this.mapClip(await this.clipsService.findOne(req.user.id, cid));
  }

  @Post('from-analysis/:videoId')
  async createFromAnalysis(@Param('videoId') videoId: string, @Request() req) {
    const clips = await this.clipsService.createAllFromAnalysis(
      req.user.id,
      videoId,
    );
    return clips.map((c) => this.mapClip(c));
  }

  @Post('manual/:videoId')
  async createManual(
    @Param('videoId') videoId: string,
    @Body() body: any,
    @Request() req,
  ) {
    return this.mapClip(
      await this.clipsService.createManual(req.user.id, videoId, body),
    );
  }

  @Post(':id/export')
  async exportClip(
    @Param('id') id: string,
    @Body() options: any,
    @Request() req,
  ) {
    await this.exportQueue.add(ClipJobType.EXPORT_CLIP, {
      clipId: id,
      options,
      usuarioId: req.user.id,
    });
    return { success: true, message: 'Exportação iniciada em segundo plano' };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any, @Request() req) {
    return this.mapClip(await this.clipsService.update(req.user.id, id, body));
  }

  @Patch(':id/metadata')
  async updateMetadata(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req,
  ) {
    return this.mapClip(
      await this.clipsService.updateMetadata(req.user.id, id, body),
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req) {
    return this.clipsService.remove(req.user.id, id);
  }

  @Post('bulk-export/:videoId')
  async bulkExport(
    @Param('videoId') videoId: string,
    @Body() options: any,
    @Request() req,
  ) {
    await this.clipsService.bulkExport(req.user.id, videoId, options);
    return { success: true, message: 'Processamento em massa iniciado' };
  }
}
