import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Queue } from 'bull';
import { Video } from '../../entities/video.entity';
import { Projeto } from '../../entities/projeto.entity';
import { Usuario } from '../../entities/usuario.entity';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
const execAsync = promisify(exec);
const ffmpegPath = require('ffmpeg-static');
import { TranscriptionService } from '../transcription/transcription.service';
import { CreditsService } from '../credits/credits.service';
import { VIDEO_QUEUE, VideoJobType } from '../queue/queue.constants';
import { TenantDbManager } from '../tenant/tenant-db.manager';
import { StorageService } from '../../common/storage/storage.service';
import { PLANS } from '../billing/billing.constants';

export interface ClipPreferences {
  aspect_ratio: string;
  proporcao_tela?: string;
  min_clips: number;
  max_clips: number;
  layout: 'auto' | 'face_tracking' | 'centered' | 'split' | 'react';
  analysis_start?: number;
  analysis_end?: number;
  target_duration?: number;
}

const DEFAULT_PREFERENCES: ClipPreferences = {
  aspect_ratio: '9:16',
  proporcao_tela: '9:16',
  min_clips: 1,
  max_clips: 1,
  layout: 'auto',
  analysis_start: 0,
  analysis_end: 0,
};

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectQueue(VIDEO_QUEUE) private videoQueue: Queue,
    private tenantDb: TenantDbManager,
    private transcriptionService: TranscriptionService,
    private creditsService: CreditsService,
    private storageService: StorageService,
    @InjectRepository(Usuario) private userRepo: Repository<Usuario>,
  ) { }

  private async getPlanLimits(usuarioId: string) {
    const user = await this.userRepo.findOne({ where: { id: usuarioId } });
    const planoKey = (user?.plano || 'free').toUpperCase();
    return (PLANS as any)[planoKey] || PLANS.FREE;
  }

  private async checkConcurrency(usuarioId: string, limit: number) {
    const activeJobs = await this.videoQueue.getJobs(['active', 'waiting', 'delayed']);
    const userJobs = activeJobs.filter(j => j.data?.usuarioId === usuarioId);
    if (userJobs.length >= limit) {
      throw new BadRequestException(`Limite de processamentos simultâneos atingido (${limit}). Por favor, aguarde a conclusão dos vídeos anteriores.`);
    }
  }

  private async getVideosRepo(usuarioId: string): Promise<Repository<Video>> {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Video);
  }

  private async getProjetosRepo(usuarioId: string): Promise<Repository<Projeto>> {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Projeto);
  }

  async findAll(usuarioId: string, projetoId?: string): Promise<Video[]> {
    const repo = await this.getVideosRepo(usuarioId);
    const qb = repo.createQueryBuilder('video')
      .innerJoin('video.projeto', 'projeto', 'projeto.usuario_id = :usuarioId', { usuarioId })
      .leftJoinAndSelect('video.cortes', 'cortes');

    if (projetoId) {
      qb.andWhere('video.projeto_id = :projetoId', { projetoId });
    }

    qb.orderBy('video.criado_em', 'DESC');
    return qb.getMany();
  }

  async findOne(usuarioId: string, id: string): Promise<Video> {
    const repo = await this.getVideosRepo(usuarioId);
    const video = await repo.createQueryBuilder('video')
      .innerJoin('video.projeto', 'projeto', 'projeto.usuario_id = :usuarioId', { usuarioId })
      .leftJoinAndSelect('video.cortes', 'cortes')
      .leftJoinAndSelect('video.legendas', 'legendas')
      .where('video.id = :id', { id })
      .getOne();

    if (!video) throw new NotFoundException(`Video ${id} não encontrado`);
    return video;
  }

  async importFromYoutube(usuarioId: string, projetoId: string, youtubeUrl: string, preferences?: any): Promise<Video> {
    const projetoRepo = await this.getProjetosRepo(usuarioId);
    const projeto = await projetoRepo.findOne({ where: { id: projetoId, usuario_id: usuarioId } });
    if (!projeto) throw new NotFoundException('Projeto inválido');

    const youtubeId = this.extractYoutubeId(youtubeUrl);
    if (!youtubeId) throw new BadRequestException('URL do YouTube inválida');

    const metadata = await this.fetchYoutubeMetadata(youtubeId);
    
    // ── Pre-check: Plan limits ──
    const limits = await this.getPlanLimits(usuarioId);
    if (metadata.duration > limits.max_source_duration) {
      const maxMin = Math.round(limits.max_source_duration / 60);
      throw new BadRequestException(`O vídeo é muito longo para seu plano atual. Limite: ${maxMin} minutos.`);
    }
    await this.checkConcurrency(usuarioId, limits.concurrent_jobs);

    // Clean URL: strip playlist/radio params, keep only video ID
    const cleanUrl = `https://www.youtube.com/watch?v=${youtubeId}`;

    const videoRepo = await this.getVideosRepo(usuarioId);
    const prefs: ClipPreferences = {
      ...DEFAULT_PREFERENCES,
      ...(preferences || {}),
    };

    const video = videoRepo.create({
      id: uuidv4(),
      projeto_id: projetoId,
      titulo: metadata.title,
      tipo_fonte: 'youtube',
      url_fonte: cleanUrl,
      youtube_id: youtubeId,
      miniatura_youtube: metadata.thumbnail,
      criador: metadata.creator,
      visualizacoes: metadata.views,
      curtidas: metadata.likes,
      comentarios: metadata.comments,
      duracao: metadata.duration,
      status_transcricao: 'draft',
      status_analise: 'draft',
      preferencias_corte: prefs as any,
    });
    const saved = await videoRepo.save(video);

    // ── Credit gate: check before processing ────────────────────────────
    const start = prefs.analysis_start || 0;
    const end = prefs.analysis_end || metadata.duration || 0;
    const durationMin = Math.max(1, (end - start) / 60); // Min 1 min
    
    const creditCheck = await this.creditsService.checkCredits(usuarioId, durationMin);
    if (!creditCheck.hasCredits) {
      throw new BadRequestException(
        `Créditos insuficientes. Necessário: ${creditCheck.required}, disponível: ${creditCheck.available}`
      );
    }
    await this.creditsService.deductCredits(usuarioId, durationMin, `Importação: ${metadata.title}`);

    // Auto-trigger full processing (analysis + rendering) for Link imports
    return this.startProcessing(usuarioId, saved.id, prefs, false);
  }

  async getYoutubeMetadata(url: string): Promise<any> {
    const youtubeId = this.extractYoutubeId(url);
    if (!youtubeId) throw new BadRequestException('URL do YouTube inválida');
    return this.fetchYoutubeMetadata(youtubeId);
  }

  async uploadVideo(usuarioId: string, projetoId: string, file: Express.Multer.File): Promise<Video> {
    const projetoRepo = await this.getProjetosRepo(usuarioId);
    const projeto = await projetoRepo.findOne({ where: { id: projetoId, usuario_id: usuarioId } });
    if (!projeto) throw new NotFoundException('Projeto inválido');

    // ── Pre-check: Plan limits ──
    const limits = await this.getPlanLimits(usuarioId);
    const fileSizeMb = file.size / (1024 * 1024);
    if (fileSizeMb > limits.max_upload_size_mb) {
      throw new BadRequestException(`O arquivo excede o limite do seu plano (${limits.max_upload_size_mb}MB).`);
    }
    await this.checkConcurrency(usuarioId, limits.concurrent_jobs);

    const videoId = uuidv4();
    const videoRepo = await this.getVideosRepo(usuarioId);

    // Upload direto para Supabase Storage
    const fileExt = path.extname(file.originalname);
    const relativePath = `${videoId}/video${fileExt}`;
    const contentType = file.mimetype || 'video/mp4';

    await this.storageService.uploadFile(relativePath, file.buffer, contentType);

    // ── Extrair thumbnail localmente com FFmpeg ──
    let thumbRelativePath: string | null = null;
    let tempVideoPath: string | null = null;
    let thumbPath: string | null = null;
    let duration = 0;
    try {
      const tempDir = this.storageService.getTempDir(`upload_thumb_${videoId}`);
      tempVideoPath = path.join(tempDir, `video_${videoId}${fileExt}`);
      thumbPath = path.join(tempDir, `thumb_${videoId}.jpg`);
      
      // Salva o buffer em disco temporariamente sem bloquear o event loop
      await fs.promises.writeFile(tempVideoPath, file.buffer);
      
      // Extrai um frame do 1º segundo (ou inicio se for curto)
      await execAsync(`"${ffmpegPath}" -i "${tempVideoPath}" -ss 00:00:01.000 -vframes 1 -y "${thumbPath}"`);
      
      // Extrair a duração do vídeo lendo a saída do ffmpeg (ele dá erro sem output, mas imprime o metadata)
      try {
        await execAsync(`"${ffmpegPath}" -i "${tempVideoPath}"`);
      } catch (e: any) {
        const stderr = e.stderr || '';
        const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
        if (match) {
          duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
        }
      }
      
      if (fs.existsSync(thumbPath)) {
        const thumbBuffer = await fs.promises.readFile(thumbPath);
        thumbRelativePath = `${videoId}/thumbnail.jpg`;
        await this.storageService.uploadFile(thumbRelativePath, thumbBuffer, 'image/jpeg');
      }
    } catch (err: any) {
      this.logger.warn(`Falha ao extrair thumbnail do vídeo upado ${videoId}: ${err.message}`);
    } finally {
      if (tempVideoPath && fs.existsSync(tempVideoPath)) {
        try { fs.unlinkSync(tempVideoPath); } catch {}
      }
      if (thumbPath && fs.existsSync(thumbPath)) {
        try { fs.unlinkSync(thumbPath); } catch {}
      }
    }

    const video = videoRepo.create({
      id: videoId,
      projeto_id: projetoId,
      titulo: file.originalname.replace(/\.[^/.]+$/, ''),
      tipo_fonte: 'upload',
      caminho_arquivo: relativePath,
      miniatura_youtube: thumbRelativePath || undefined,
      duracao: duration,
      status_transcricao: 'draft',
      status_analise: 'draft',
      preferencias_corte: DEFAULT_PREFERENCES,
    });
    return videoRepo.save(video);
  }

  async startProcessing(usuarioId: string, videoId: string, preferences: ClipPreferences, analysisOnly = false): Promise<Video> {
    const video = await this.findOne(usuarioId, videoId);

    // ── Credit gate for uploaded videos (YouTube imports already checked) ──
    if (video.tipo_fonte !== 'youtube') {
      const start = preferences.analysis_start || 0;
      const end = preferences.analysis_end || video.duracao || 0;
      const durationMin = Math.max(1, (end - start) / 60);

      const creditCheck = await this.creditsService.checkCredits(usuarioId, durationMin);
      if (!creditCheck.hasCredits) {
        throw new BadRequestException(
          `Créditos insuficientes. Necessário: ${creditCheck.required}, disponível: ${creditCheck.available}`
        );
      }
      await this.creditsService.deductCredits(usuarioId, durationMin, `Processamento: ${video.titulo}`);
    }

    const prefs: ClipPreferences = {
      ...DEFAULT_PREFERENCES,
      ...preferences,
    };

    // Normalize aspect ratio mapping (Frontend uses aspect_ratio, Backend uses proporcao_tela)
    if ((preferences as any).aspect_ratio && !prefs.proporcao_tela) {
      prefs.proporcao_tela = (preferences as any).aspect_ratio;
    }


    const videoRepo = await this.getVideosRepo(usuarioId);
    await videoRepo.update(videoId, {
      preferencias_corte: prefs as any,
      status_transcricao: 'pending',
      status_analise: 'pending'
    });

    if (video.tipo_fonte === 'youtube') {
      await this.videoQueue.add(VideoJobType.DOWNLOAD_YOUTUBE,
        { videoId, youtubeUrl: video.url_fonte, preferences: prefs, usuarioId, analysisOnly },
        { jobId: `yt-${videoId}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
      );
    } else if (video.caminho_arquivo) {
      await this.videoQueue.add(VideoJobType.PROCESS_UPLOADED,
        { videoId, filePath: video.caminho_arquivo, preferences: prefs, usuarioId, analysisOnly },
        { jobId: `upload-${videoId}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
      );
    }
    return this.findOne(usuarioId, videoId);
  }

  async uploadAudioForVideo(usuarioId: string, videoId: string, file: Express.Multer.File): Promise<Video> {
    const video = await this.findOne(usuarioId, videoId);
    const videoRepo = await this.getVideosRepo(usuarioId);

    const fileExt = path.extname(file.originalname || '.mp4');
    const relativePath = `${videoId}/video${fileExt}`;
    const contentType = file.mimetype || 'video/mp4';

    // Upload direto para Supabase Storage
    await this.storageService.uploadFile(relativePath, file.buffer, contentType);

    await videoRepo.update(videoId, {
      caminho_arquivo: relativePath,
      status_transcricao: 'processing',
      status_analise: 'pending'
    });

    const prefs = video.preferencias_corte || DEFAULT_PREFERENCES;
    await this.videoQueue.add(VideoJobType.PROCESS_UPLOADED,
      { videoId, filePath: relativePath, preferences: prefs, usuarioId },
      { jobId: `audio-${videoId}-${Date.now()}` }
    );
    return this.findOne(usuarioId, videoId);
  }

  async getJobStatus(usuarioId: string, videoId: string): Promise<any> {
    // First try to get live job info from queue
    const jobs = await this.videoQueue.getJobs(['active', 'waiting', 'delayed', 'failed', 'completed']);
    const job = jobs.find((j) => j.data?.videoId === videoId);

    // Also read DB status for accurate progress mapping
    const video = await this.findOne(usuarioId, videoId).catch(() => null);
    const transcriptStatus = video?.['status_transcricao'] ?? (video as any)?.transcript_status;
    const analysisStatus = video?.['status_analise'] ?? (video as any)?.analysis_status;

    // Derive progress from DB status when no live job found
    let progress = 0;
    let message = '';
    let status = 'not_in_queue';

    if (transcriptStatus === 'pending' || transcriptStatus === 'processing') {
      progress = transcriptStatus === 'processing' ? 35 : 10;
      message = transcriptStatus === 'processing' ? 'Transcrevendo áudio...' : 'Baixando vídeo...';
      status = 'active';
    } else if (transcriptStatus === 'completed' && (analysisStatus === 'pending' || analysisStatus === 'processing')) {
      progress = analysisStatus === 'processing' ? 70 : 60;
      message = 'Analisando com IA...';
      status = 'active';
    } else if (analysisStatus === 'completed') {
      // Check if clips are still rendering
      const ds = await this.tenantDb.getTenantDataSource(usuarioId);
      const repo = ds.getRepository(require('../../entities/corte.entity').Corte);
      const clips = await repo.find({ where: { video_id: videoId } });
      const allDone = clips.length > 0 && clips.every((c: any) => c.status === 'completed' || c.status === 'done');
      const anyPending = clips.some((c: any) => c.status === 'pending' || c.status === 'processing');

      if (anyPending) {
        progress = 88;
        message = `Renderizando clipes (${clips.filter((c: any) => c.status === 'completed' || c.status === 'done').length}/${clips.length})...`;
        status = 'active';
      } else if (allDone) {
        progress = 100;
        message = 'Concluído!';
        status = 'completed';
      } else if (clips.length === 0) {
        if (!job) {
          progress = 100;
          message = 'Nenhum clipe pôde ser gerado';
          status = 'completed';
        } else {
          progress = 85;
          message = 'Criando clipes...';
          status = 'active';
        }
      }
    } else if (transcriptStatus === 'error' || analysisStatus === 'error') {
      status = 'failed';
      message = 'Erro no processamento';
    }

    // Override with live queue data if available and more up to date
    if (job) {
      const jobState = await job.getState();
      const jobProgress = job.progress();
      if (typeof jobProgress === 'number' && jobProgress > 0) {
        progress = jobProgress;
      }
      if (jobState === 'failed') {
        status = 'failed';
        message = job.failedReason || 'Erro';
      } else if (jobState === 'completed') {
        status = 'completed';
      } else if (jobState === 'active' || jobState === 'waiting') {
        status = 'active';
      }
    }

    return { status, progress, message };
  }

  async update(usuarioId: string, id: string, data: Partial<Video>): Promise<Video> {
    await this.findOne(usuarioId, id); // Ensure ownership
    const videoRepo = await this.getVideosRepo(usuarioId);
    await videoRepo.update(id, data);
    return this.findOne(usuarioId, id);
  }
  async remove(usuarioId: string, id: string): Promise<void> {
    await this.findOne(usuarioId, id); // Ensure ownership

    // 1. Delete todos os arquivos da pasta do vídeo no Supabase Storage
    try {
      await this.storageService.deleteFolder(id);
      this.logger.log(`[videos] Deleted video folder from Supabase: ${id}`);
    } catch (e) {
      this.logger.warn(`[videos] Failed to delete video folder ${id}: ${e.message}`);
    }

    // 2. Cleanup jobs
    try {
      const job = await this.videoQueue.getJob(`yt-${id}`);
      if (job) await job.remove();
    } catch { /* ignored */ }

    // 3. Delete from database (cascades to clips/subtitles)
    const videoRepo = await this.getVideosRepo(usuarioId);
    await videoRepo.delete(id);
  }

  async retriggerProcessing(usuarioId: string, id: string): Promise<Video> {
    const video = await this.findOne(usuarioId, id);
    const prefs = video.preferencias_corte || DEFAULT_PREFERENCES;

    if (video.tipo_fonte === 'youtube') {
      await this.videoQueue.add(VideoJobType.DOWNLOAD_YOUTUBE,
        { videoId: id, youtubeUrl: video.url_fonte, preferences: prefs, usuarioId },
        { jobId: `yt-retry-${id}-${Date.now()}` }
      );
    } else if (video.caminho_arquivo) {
      await this.videoQueue.add(VideoJobType.PROCESS_UPLOADED,
        { videoId: id, filePath: video.caminho_arquivo, preferences: prefs, usuarioId },
        { jobId: `upload-retry-${id}-${Date.now()}` }
      );
    }
    return video;
  }

  private extractYoutubeId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /youtube\.com\/shorts\/([^&\n?#]+)/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  private async fetchYoutubeMetadata(youtubeId: string): Promise<any> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    try {
      const r = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { id: youtubeId, key: apiKey, part: 'snippet,statistics,contentDetails' }
      });
      const item = r.data.items?.[0];
      if (!item) throw new Error('Not found');
      return {
        title: item.snippet.title,
        creator: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails?.maxres?.url || item.snippet.thumbnails?.high?.url,
        views: parseInt(item.statistics.viewCount) || 0,
        likes: parseInt(item.statistics.likeCount) || 0,
        comments: parseInt(item.statistics.commentCount) || 0,
        duration: this.parseIsoDuration(item.contentDetails?.duration)
      };
    } catch {
      return {
        title: `YouTube Video ${youtubeId}`,
        creator: 'Unknown',
        thumbnail: `https://img.youtube.com/vi/${youtubeId}/maxresdefault.jpg`,
        views: 0,
        likes: 0,
        comments: 0,
        duration: 0
      };
    }
  }

  private parseIsoDuration(d: string): number {
    if (!d) return 0;
    const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || '0') * 3600) + (parseInt(m[2] || '0') * 60) + parseInt(m[3] || '0');
  }
}
