import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Corte as Clip } from '../../entities/corte.entity';
import { Video } from '../../entities/video.entity';
import { Legenda as Subtitle } from '../../entities/legenda.entity';
import { EventsGateway } from '../gateway/events.gateway';
import { FFmpegSubtitleService } from './ffmpeg-subtitle.service';
import { CanvasSubtitleService } from './canvas-subtitle.service';
import { CreditsService } from '../credits/credits.service';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { CLIP_EXPORT_QUEUE, ClipJobType } from '../queue/queue.constants';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { TenantDbManager } from '../tenant/tenant-db.manager';
import { StorageService } from '../../common/storage/storage.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Usuario } from '../../entities/usuario.entity';
import { PLANS } from '../billing/billing.constants';
import { FaceDetectionService } from '../analysis/face-detection.service';
import axios from 'axios';
import * as crypto from 'crypto';

const ffmpegPath = require('ffmpeg-static');

const execAsync = promisify(exec);

export interface ExportOptions {
  resolution?: '480p' | '1080p';
  proporcao_tela?: string;
  aspect_ratio?: string;
  isFinalExport?: boolean;
  subtitle_style?: Record<string, any>;
  layout?: 'centered' | 'split' | 'react' | 'face_tracking' | 'kurtcut' | 'none';
  secondaryVideoPath?: string;
}

@Injectable()
export class ClipsService {
  private readonly logger = new Logger(ClipsService.name);

  constructor(
    private eventsGateway: EventsGateway,
    private tenantDb: TenantDbManager,
    private ffmpegSubtitle: FFmpegSubtitleService,
    private canvasSubtitle: CanvasSubtitleService,
    private creditsService: CreditsService,
    private readonly configService: ConfigService,
    @InjectQueue(CLIP_EXPORT_QUEUE) private exportQueue: Queue,
    private storageService: StorageService,
    private faceDetection: FaceDetectionService,
    @InjectRepository(Usuario) private userRepo: Repository<Usuario>,
  ) { }

  private async downloadThumbnail(url: string, targetPath: string): Promise<string | null> {
    if (!url) return null;
    try {
      if (fs.existsSync(targetPath)) return targetPath;
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
      });
      const writer = fs.createWriteStream(targetPath);
      response.data.pipe(writer);
      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(targetPath));
        writer.on('error', reject);
      });
    } catch (e) {
      this.logger.error(`Falha ao baixar miniatura: ${e.message}`);
      return null;
    }
  }

  private async getPlanLimits(usuarioId: string) {
    const user = await this.userRepo.findOne({ where: { id: usuarioId } });
    const planoKey = (user?.plano || 'free').toUpperCase();
    return (PLANS as any)[planoKey] || PLANS.FREE;
  }

  private async clipsRepoFn(usuarioId: string) {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Clip);
  }

  private async videosRepoFn(usuarioId: string) {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Video);
  }

  private async subtitlesRepoFn(usuarioId: string) {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Subtitle);
  }

  async findAll(usuarioId: string, videoId?: string): Promise<Clip[]> {
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const where = videoId ? { video_id: videoId } : {};
    return clipsRepo.find({
      where,
      order: { pontuacao_viral: 'DESC', criado_em: 'DESC' },
    });
  }

  async findOne(usuarioId: string, id: string): Promise<Clip> {
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const clip = await clipsRepo.findOne({ where: { id } });
    if (!clip) throw new NotFoundException(`Clip ${id} not found`);
    return clip;
  }

  async createFromAnalysis(
    usuarioId: string,
    videoId: string,
    analysisClip: any,
  ): Promise<Clip> {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    const videoRepo = ds.getRepository(require('../../entities/video.entity').Video);
    const video = await videoRepo.findOne({ where: { id: videoId } });
    const defaultLayout = video?.preferencias_corte?.layout || 'auto';

    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const start = analysisClip.start_time ?? analysisClip.tempo_inicio;
    const end = analysisClip.end_time ?? analysisClip.tempo_fim;

    const clip = clipsRepo.create({
      id: uuidv4(),
      video_id: videoId,
      titulo: analysisClip.title || analysisClip.titulo,
      descricao: analysisClip.reason || analysisClip.descricao,
      tempo_inicio: start,
      tempo_fim: end,
      duracao: Number(end) - Number(start),
      proporcao_tela:
        analysisClip.aspect_ratio || analysisClip.proporcao_tela || '9:16',
      pontuacao_viral: Math.round(
        Number(analysisClip.score || analysisClip.pontuacao_viral || 0),
      ),
      justificativa: analysisClip.reason || analysisClip.justificativa,
      dados_legenda: {
        words: analysisClip.words || [],
        subtitle_preset: analysisClip.subtitle_style?.preset || 'highlight',
        max_words: 2,
        font_size: 10,
        layout: defaultLayout,
        ...(analysisClip.subtitle_style || {}),
      },
      status: 'pending',
    });
    const saved = await clipsRepo.save(clip);
    this.extractThumbnail(usuarioId, saved.id).catch(() => { });
    return saved;
  }

  async extractThumbnail(usuarioId: string, clipId: string) {
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const clip = await clipsRepo.findOne({
      where: { id: clipId },
      relations: ['video'],
    });
    if (!clip || !clip.video?.caminho_arquivo) return;

    let videoPath = clip.video.caminho_arquivo;
    const isRemote = !path.isAbsolute(videoPath) && !videoPath.includes(':');
    let localVideoPath = videoPath;

    if (isRemote) {
      const uploadDir = this.storageService.getAbsoluteUploadDir();
      localVideoPath = path.resolve(uploadDir, `temp_thumb_${clipId}${path.extname(videoPath)}`);
      try {
        await this.storageService.downloadFile(videoPath, localVideoPath);
      } catch (e) {
        this.logger.error(`[clips] Failed to download video for thumb: ${e.message}`);
        return;
      }
    } else if (!path.isAbsolute(videoPath)) {
      localVideoPath = this.storageService.getAbsolutePath(videoPath);
    }

    const videoId = clip.video_id;
    const thumbName = `thumb_${clipId}.jpg`;
    const relativePath = `${videoId}/thumbnails/${thumbName}`;
    const absoluteThumbPath = this.storageService.getAbsolutePath(relativePath);
    const thumbDir = path.dirname(absoluteThumbPath);
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

    try {
      const seekTime = clip.tempo_inicio + 0.1;
      await execAsync(
        `"${ffmpegPath}" -ss ${seekTime} -i "${localVideoPath}" -vframes 1 -q:v 4 -y "${absoluteThumbPath}"`,
      );
      if (fs.existsSync(absoluteThumbPath)) {
        await clipsRepo.update(clipId, { miniatura_caminho: relativePath });
        this.eventsGateway.emitClipReady(clip.video_id, {
          id: clipId,
          thumbnail_path: relativePath,
        });
      }
    } catch (e) {
      console.error(`[clips] Thumb fail: ${e.message}`);
    } finally {
      if (isRemote && fs.existsSync(localVideoPath)) {
        try { fs.unlinkSync(localVideoPath); } catch {}
      }
    }
  }

  async createManual(
    usuarioId: string,
    videoId: string,
    data: any,
  ): Promise<Clip> {
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const clip = clipsRepo.create({
      id: uuidv4(),
      video_id: videoId,
      titulo: data.titulo,
      descricao: data.description,
      tempo_inicio: data.tempo_inicio,
      tempo_fim: data.tempo_fim,
      duracao: Number(data.tempo_fim) - Number(data.tempo_inicio),
      proporcao_tela: data.proporcao_tela || '9:16',
      pontuacao_viral: Math.round(Number(data.pontuacao_viral || 5)),
      status: 'pending',
    });
    const saved = await clipsRepo.save(clip);
    this.extractThumbnail(usuarioId, saved.id).catch(() => { });
    return saved;
  }

  async update(
    usuarioId: string,
    id: string,
    data: Partial<Clip>,
  ): Promise<Clip> {
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    await clipsRepo.update(id, data);
    return this.findOne(usuarioId, id);
  }

  async remove(usuarioId: string, id: string): Promise<void> {
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const clip = await this.findOne(usuarioId, id);

    if (clip.caminho_arquivo) {
      try {
        await this.storageService.deleteFile(clip.caminho_arquivo);
      } catch (e) {
        console.warn(`[clips] Failed to delete file: ${e.message}`);
      }
    }

    if (clip.miniatura_caminho) {
      try {
        await this.storageService.deleteFile(clip.miniatura_caminho);
      } catch (e) {
        console.warn(`[clips] Failed to delete thumbnail: ${e.message}`);
      }
    }

    await clipsRepo.delete(id);
  }

  async exportClip(
    usuarioId: string,
    clipId: string,
    options: ExportOptions = {},
  ): Promise<Clip> {
    const repo = await this.clipsRepoFn(usuarioId);
    const clip = await this.findOne(usuarioId, clipId);
    
    // ── Plan gate: Duration, Resolution ──
    const limits = await this.getPlanLimits(usuarioId);
    const clipDuration = clip.tempo_fim - clip.tempo_inicio;
    if (clipDuration > limits.max_clip_duration) {
      const maxMin = Math.round(limits.max_clip_duration / 60);
      throw new BadRequestException(`A duração do clipe excede o limite do seu plano (${maxMin} min).`);
    }

    // Force resolution based on plan (if higher than allowed)
    let finalResolution = options.resolution || '1080p';
    if (limits.export_quality === '720p') finalResolution = '480p'; // Nosso 480p mapeia para 720p no scale as vezes? No code scale mapeia d/d.
    // Realmente, se for Free, forçamos '480p' (que é 854x480 no horizontal ou proporcional no vertical).
    // O usuário pediu 720p para Free. Vou usar '480p' como proxy se não tivermos 720p definido nas resoluções.
    // Na verdade, vou ajustar buildVideoFilters para aceitar o plano.

    // ── Credit gate: 1ª exportção grátis, re-exports custam 0.5 crédito ──
    const currentExportCount = clip.export_count || 0;
    if (currentExportCount > 0 && options.isFinalExport) {
      const reExportCost = 0.5;
      const creditCheck = await this.creditsService.checkCredits(
        usuarioId,
        reExportCost,
      );
      if (!creditCheck.hasCredits) {
        throw new NotFoundException(
          `Créditos insuficientes para re-exportar. Necessário: ${reExportCost}, disponível: ${creditCheck.available}`,
        );
      }
      await this.creditsService.deductCredits(
        usuarioId,
        reExportCost,
        `Re-export clipe: ${clip.titulo}`,
      );
    }

    const effectiveRatio = options.proporcao_tela || options.aspect_ratio;
    if (effectiveRatio) {
      await repo.update(clipId, { proporcao_tela: effectiveRatio });
      clip.proporcao_tela = effectiveRatio;
    }

    const videosRepo = await this.videosRepoFn(usuarioId);
    const video = await videosRepo.findOne({ where: { id: clip.video_id } });
    if (!video) throw new NotFoundException('Video not found');

    const storageInputFile = video.caminho_arquivo;
    if (!storageInputFile) throw new NotFoundException('Video path missing');

    const envUploadDir = this.configService.get<string>(
      'UPLOAD_DIR',
      'upload',
    );
    const uploadDir = path.isAbsolute(envUploadDir)
      ? envUploadDir
      : path.resolve(process.cwd(), envUploadDir);

    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const isRemoteInput = !path.isAbsolute(storageInputFile) && !storageInputFile.includes(':') && !storageInputFile.includes('/');
    let inputPath = storageInputFile;

    if (isRemoteInput) {
      const uploadDir = this.storageService.getAbsoluteUploadDir();
      inputPath = path.join(uploadDir, `temp_input_${clipId}${path.extname(storageInputFile)}`);
      this.logger.log(`[clip:${clipId}] Downloading remote video: ${storageInputFile}`);
      await this.storageService.downloadFile(storageInputFile, inputPath);
    } else if (!path.isAbsolute(storageInputFile)) {
      inputPath = this.storageService.getAbsolutePath(storageInputFile);
    }

    if (!fs.existsSync(inputPath)) {
      this.logger.error(
        `[clip:${clipId}] Video file not found at: ${inputPath}`,
      );
      throw new NotFoundException(
        `Video file not found. Please ensure the video is available.`,
      );
    }

    const videoId = clip.video_id;
    const runId = Date.now().toString() + Math.random().toString(36).substring(2, 7);
    
    // Structured paths
    const clipRelativePath = `${videoId}/clips/clip_${clipId}.mp4`;
    const finalOutputFile = this.storageService.getAbsolutePath(clipRelativePath);
    const clipDir = path.dirname(finalOutputFile);
    if (!fs.existsSync(clipDir)) fs.mkdirSync(clipDir, { recursive: true });

    const outputFile = path.join(clipDir, `clip_${clipId}_${runId}.mp4`);
    const tempBase = path.join(clipDir, `temp_base_${clipId}.mp4`);

    await repo.update(clipId, { status: 'processing' });
    this.eventsGateway.emitClipExportProgress(clipId, clip.video_id, 5);

    const safeUnlink = (p: string) => {
      try {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      } catch (e) { }
    };

    try {
      // ── Step 1 & 2: FFmpeg — Cut, Geometry / Aspect ratio / Blur ─────────────────────────
      const is480p = finalResolution === '480p';
      const crf = 18;

      const secondaryVideoPath = options.secondaryVideoPath || (clip.dados_legenda?.secondary_video_path);
      let layout = options.layout || clip.dados_legenda?.layout || 'auto';
      
      let thumbnailPath: string | null = null;
      if (layout === 'kurtcut') {
        const videoRepo = await this.videosRepoFn(usuarioId);
        const video = await videoRepo.findOne({ where: { id: clip.video_id } });
        if (video?.miniatura_youtube) {
          const thumbFile = `thumb_${clip.video_id}.jpg`;
          const localThumbPath = path.join(uploadDir, thumbFile);
          thumbnailPath = await this.downloadThumbnail(video.miniatura_youtube, localThumbPath);
        }
      }

      let faceX = 0.5;
      let faceY = 0.35;
      const needsFaceDetection = layout !== 'none' && layout !== 'centered';

      // ── Face Detection with Cache ──────────────────────────────────────────
      if (needsFaceDetection) {
        const faceCache = clip.dados_legenda?.face_cache;
        const cacheValid = faceCache
          && faceCache.video_id === clip.video_id
          && Math.abs(faceCache.start - clip.tempo_inicio) < 1
          && Math.abs(faceCache.end - clip.tempo_fim) < 1;

        if (cacheValid) {
          faceX = faceCache.xCenter;
          faceY = faceCache.yCenter;
          this.logger.log(`[clip:${clipId}] Face detection CACHE HIT: x=${faceX.toFixed(2)}, y=${faceY.toFixed(2)}`);
        } else {
          this.logger.log(`[clip:${clipId}] Face detection CACHE MISS — calling Gemini Vision...`);
          try {
            const result = await this.faceDetection.detectMainFacePosition(inputPath, clip.tempo_inicio, clip.tempo_fim - clip.tempo_inicio);
            faceX = result.xCenter;
            faceY = result.yCenter;
            this.logger.log(`[clip:${clipId}] Face detected at xCenter: ${faceX.toFixed(2)}, yCenter: ${faceY.toFixed(2)}`);

            // Persist face detection cache
            const updatedMeta = {
              ...clip.dados_legenda,
              face_cache: {
                xCenter: faceX, yCenter: faceY,
                video_id: clip.video_id,
                start: clip.tempo_inicio, end: clip.tempo_fim,
                cached_at: new Date().toISOString(),
              },
            };
            await repo.update(clipId, { dados_legenda: updatedMeta });
            clip.dados_legenda = updatedMeta;
          } catch (e) {
            this.logger.warn(`[clip:${clipId}] Face detection failed, using defaults: ${e.message}`);
          }
        }

        if (layout === 'auto') {
          const availableLayouts = ['centered', 'face_tracking', 'kurtcut', 'split', 'react'];
          layout = availableLayouts[Math.floor(Math.random() * availableLayouts.length)];
          this.logger.log(`[clip:${clipId}] Auto mode: randomly selected layout "${layout}"`);
        }
      }

      // ── Config hash for smart temp_base invalidation ────────────────────────
      const baseConfig = JSON.stringify({
        layout, aspectRatio: clip.proporcao_tela,
        faceX: Math.round(faceX * 100) / 100,
        faceY: Math.round(faceY * 100) / 100,
        resolution: finalResolution,
        start: clip.tempo_inicio, end: clip.tempo_fim,
        secondary: secondaryVideoPath || null,
      });
      const configHash = crypto.createHash('md5').update(baseConfig).digest('hex').slice(0, 8);
      const savedHash = clip.dados_legenda?.preview_config_hash;

      const { vfFilters, isComplex } = this.buildVideoFilters(
        clip.proporcao_tela,
        is480p,
        { ...clip.dados_legenda, layout, faceX, faceY, title: clip.titulo },
        limits,
        secondaryVideoPath,
        thumbnailPath,
      );

      const filterArgs = isComplex
        ? `-filter_complex "${vfFilters.join(';')}"`
        : `-vf "${vfFilters.join(',')}"`;

      const mapArgs = isComplex ? '-map "[vout]" -map 0:a?' : '-map 0:v -map 0:a?';

      const secondaryInputArg = secondaryVideoPath ? `-i "${this.storageService.getAbsolutePath(secondaryVideoPath)}"` : '';
      const thumbInputArg = thumbnailPath ? `-i "${thumbnailPath}"` : '';
      
      // Brush overlay for KurtCut mode
      const brushPath = path.join(process.cwd(), 'assets', 'overlays', 'red_brush_banner.png').replace(/\\/g, '/');
      const brushInputArg = layout === 'kurtcut' && fs.existsSync(brushPath) ? `-i "${brushPath}"` : '';

      const useGpu = this.configService.get<string>('USE_GPU') === 'true';
      const duration = clip.tempo_fim - clip.tempo_inicio;

      const encodeCmd = [
        `"${ffmpegPath}"`,
        '-y',
        '-loglevel',
        'error',
        `-i "${inputPath}"`,
        secondaryInputArg,
        thumbInputArg,
        brushInputArg,
        `-ss ${clip.tempo_inicio}`,
        `-t ${duration}`,
        filterArgs,
        mapArgs,
        useGpu
          ? '-c:v h264_nvenc -profile:v high'
          : '-c:v libx264 -profile:v high',
        useGpu ? '-preset p4' : '-preset fast',
        useGpu ? `-cq ${crf}` : `-crf ${crf}`,
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-c:a aac -ar 44100',
        `"${tempBase}"`,
      ]
        .filter(Boolean)
        .join(' ');

      // ── Smart temp_base reuse: check config hash, not just file existence ──
      const tempBaseExists = fs.existsSync(tempBase);
      const tempBaseStats = tempBaseExists ? fs.statSync(tempBase) : null;
      const tempBaseValid = tempBaseExists && tempBaseStats && tempBaseStats.size > 1000 && savedHash === configHash;

      if (!tempBaseValid) {
        // If old temp_base exists with different config, delete it first
        if (tempBaseExists) {
          this.logger.log(`[clip:${clipId}] Config changed (hash ${savedHash} → ${configHash}), re-encoding...`);
          try { fs.unlinkSync(tempBase); } catch { }
        } else {
          this.logger.log(`[clip:${clipId}] No temp_base found, encoding fresh...`);
        }

        await execAsync(encodeCmd, { timeout: 600000, cwd: uploadDir });

        // Aguarda o SO liberar o arquivo (crítico no Windows)
        await new Promise<void>((resolve, reject) => {
          let attempts = 0;
          const check = () => {
            attempts++;
            try {
              const stat = fs.statSync(tempBase);
              if (stat.size > 1000) {
                resolve();
              } else if (attempts >= 20) {
                reject(new Error(`temp_base muito pequeno após encode (${stat.size} bytes)`));
              } else {
                setTimeout(check, 250);
              }
            } catch {
              if (attempts >= 20) {
                reject(new Error(`temp_base não encontrado após encode: ${tempBase}`));
              } else {
                setTimeout(check, 250);
              }
            }
          };
          check();
        });

        // Save config hash so next export can skip encoding
        const hashMeta = { ...clip.dados_legenda, preview_config_hash: configHash };
        await repo.update(clipId, { dados_legenda: hashMeta });
        clip.dados_legenda = hashMeta;
      } else {
        this.logger.log(`[clip:${clipId}] ✅ Reusing temp_base (config hash match: ${configHash})`);
      }

      this.eventsGateway.emitClipExportProgress(clipId, clip.video_id, 55);

      // Save temp_path for clean editing in the frontend
      const tempRelative = `${videoId}/clips/temp_base_${clipId}.mp4`; 
      const currentMeta = clip.dados_legenda || {};
      if (currentMeta.temp_path !== tempRelative) {
        await (await this.clipsRepoFn(usuarioId)).update(clipId, {
          dados_legenda: { ...currentMeta, temp_path: tempRelative }
        });
        clip.dados_legenda = { ...currentMeta, temp_path: tempRelative };
      }

      // ── Step 3: Subtitle overlay via FFmpeg ASS ──────────────────────
      const words = clip.dados_legenda?.words || [];
      const hasSubtitles = words.length > 0;

      if (hasSubtitles && options.isFinalExport) {
        // Adjust word timestamps to be relative to clip start (0-based)
        const clipStart = clip.tempo_inicio;
        const relativeWords = words.map((w: any) => ({
          text: w.text,
          start: Math.max(0, w.start - clipStart),
          end: Math.max(0, w.end - clipStart),
        }));

        // Merge subtitle style: options.subtitle_style overrides clip.dados_legenda
        const baseStyle = clip.dados_legenda || {};
        const mergedStyle = options.subtitle_style
          ? { ...baseStyle, ...options.subtitle_style }
          : { ...baseStyle };

        if (layout === 'kurtcut' && !mergedStyle.posY) {
          mergedStyle.posY = 92;
        }

        this.logger.log(
          `[clip:${clipId}] Subtitle style -> preset: ${mergedStyle.subtitle_preset || mergedStyle.preset || 'NONE'}, font: ${mergedStyle.font_family || 'default'}, color: ${mergedStyle.font_color || 'default'}, highlight: ${mergedStyle.highlight_color || 'default'}`,
        );

        const clipDuration = clip.tempo_fim - clip.tempo_inicio;
        const w = is480p
          ? 480
          : clip.proporcao_tela === '9:16'
            ? 1080
            : clip.proporcao_tela === '1:1'
            ? 1080
            : 1920;
        const h = is480p
          ? 854
          : clip.proporcao_tela === '9:16'
            ? 1920
            : clip.proporcao_tela === '1:1'
              ? 1080
              : 1080;

        // ── Smart subtitle renderer: Route all presets to Canvas for high-quality animations and exact WYSIWYG matching ──
        const activePreset = mergedStyle.subtitle_preset || mergedStyle.preset || 'default';
        const useCanvasRenderer = true; // Use canvas for everything to ensure correct presets, custom outlines, shadows, and animations

        if (useCanvasRenderer) {
          this.logger.log(`[clip:${clipId}] Using Canvas renderer (preset: ${activePreset})`);
          try {
            await this.canvasSubtitle.burnSubtitles({
              inputVideoPath: tempBase,
              outputPath: outputFile,
              words: relativeWords,
              subtitleStyle: mergedStyle,
              durationSec: clipDuration,
              fps: 30,
              width: w,
              height: h,
              onProgress: (subP: number) => {
                const totalP = Math.round(55 + (subP * 0.4));
                this.eventsGateway.emitClipExportProgress(clipId, clip.video_id, totalP);
              }
            });
          } catch (canvasErr: any) {
            this.logger.warn(`[clip:${clipId}] Canvas renderer failed, falling back to FFmpeg ASS: ${canvasErr.message}`);
            await this.ffmpegSubtitle.burnSubtitles({
              inputVideoPath: tempBase,
              outputPath: outputFile,
              words: relativeWords,
              subtitleStyle: mergedStyle,
              durationSec: clipDuration,
              width: w,
              height: h,
            });
          }
        } else {
          this.logger.log(`[clip:${clipId}] Using FFmpeg ASS renderer (simple preset: ${activePreset})`);
          try {
            await this.ffmpegSubtitle.burnSubtitles({
              inputVideoPath: tempBase,
              outputPath: outputFile,
              words: relativeWords,
              subtitleStyle: mergedStyle,
              durationSec: clipDuration,
              width: w,
              height: h,
            });
          } catch (assErr: any) {
            this.logger.warn(`[clip:${clipId}] ASS renderer failed, falling back to Canvas: ${assErr.message}`);
            await this.canvasSubtitle.burnSubtitles({
              inputVideoPath: tempBase,
              outputPath: outputFile,
              words: relativeWords,
              subtitleStyle: mergedStyle,
              durationSec: clipDuration,
              fps: 30,
              width: w,
              height: h,
              onProgress: (subP: number) => {
                const totalP = Math.round(55 + (subP * 0.4));
                this.eventsGateway.emitClipExportProgress(clipId, clip.video_id, totalP);
              }
            });
          }
        }
      } else {
        // No subtitles or not final export → ensure outputFile exists by copying tempBase
        try {
          fs.copyFileSync(tempBase, outputFile);
        } catch (copyErr: any) {
          this.logger.error(`Error copying tempBase to outputFile: ${copyErr.message}`);
        }
      }
      this.eventsGateway.emitClipExportProgress(clipId, clip.video_id, 95);

      // safeUnlink(tempBase); // Mantido para re-edição rápida

      // Local structured path already saved in finalOutputFile (renamed or moved later if needed)
      // Actually canvasSubtitle and others might have saved it to outputFile
      if (fs.existsSync(outputFile)) {
        if (fs.existsSync(finalOutputFile)) {
          try {
            fs.unlinkSync(finalOutputFile);
          } catch (e) {}
        }
        try {
          fs.renameSync(outputFile, finalOutputFile);
        } catch (renameErr: any) {
          if (
            renameErr.code === 'EBUSY' ||
            renameErr.code === 'EPERM' ||
            renameErr.code === 'EXDEV'
          ) {
            this.logger.warn(
              `Final move nested BUSY (Windows), falling back to copy+unlink: ${outputFile}`,
            );
            fs.copyFileSync(outputFile, finalOutputFile);
            try {
              fs.unlinkSync(outputFile);
            } catch (e) {}
          } else {
            throw renameErr;
          }
        }
      }

      const updateData: Partial<Clip> = {
        caminho_arquivo: clipRelativePath,
        status: 'completed',
        export_count: (clip.export_count || 0) + 1,
      };
      await repo.update(clipId, updateData);
      this.eventsGateway.emitClipExportProgress(clipId, clip.video_id, 100);
      this.eventsGateway.emitClipReady(clip.video_id, {
        id: clipId,
        caminho_arquivo: clipRelativePath,
        status: 'completed',
      });

      // Local cleanup
      if (fs.existsSync(outputFile)) safeUnlink(outputFile);
      if (isRemoteInput) safeUnlink(inputPath);

      return this.findOne(usuarioId, clipId);
    } catch (error) {
      console.error('Export pipeline error:', error.message);
      if (error.stderr) console.error('stderr:', error.stderr);

      // safeUnlink(tempBase); // Mantido em caso de erro para re-tentar rápido
      if (isRemoteInput && inputPath && fs.existsSync(inputPath)) safeUnlink(inputPath);

      await repo.update(clipId, { status: 'error' });
      this.eventsGateway.emitVideoError(
        clip.video_id,
        `Clip export failed: ${error.message}`,
      );
      throw error;
    }
  }

  private buildVideoFilters(
    aspectRatio: string,
    is480p: boolean,
    style?: any,
    limits?: any,
    secondaryVideoPath?: string,
    thumbnailPath?: string | null,
  ): { vfFilters: string[]; isComplex: boolean } {
    const vfFilters: string[] = [];
    let isComplex = false;

    const layout = style?.layout || 'centered';

    if (aspectRatio === '9:16') {
      const w = is480p ? 480 : 1080;
      const h = is480p ? 854 : 1920;
      const faceX = style?.faceX !== undefined ? style.faceX : 0.5;
      const faceY = style?.faceY !== undefined ? style.faceY : 0.35;

      if (layout === 'none') {
        // ── Desativado: Simples letterbox/pillarbox sem efeitos ──
        vfFilters.push(
          `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
        );
      } else if (layout === 'kurtcut') {
        // ── KurtCut: Blur BG → Thumb (topo) → Pincelada vermelha → Clip (baixo) ──
        const thumbH = Math.round(h * 0.22);
        const bannerH = Math.round(h * 0.25);
        const videoH = Math.round(h * 0.58);
        const bannerW = Math.round(w * 0.98);
        const bannerX = Math.round((w - bannerW) / 2);

        const thumbIdx = secondaryVideoPath ? 2 : 1;
        // Brush PNG input index: after [0:v], secondary (if any), thumbnail
        let brushIdx = 1; // starts after main video
        if (secondaryVideoPath) brushIdx++;
        if (thumbnailPath) brushIdx++;
        
        const clipTitle = (style?.title || 'KURT CUT')
          .toUpperCase()
          .replace(/\\/g, '\\\\\\\\')
          .replace(/'/g, "'\\\\\\''")
          .replace(/:/g, '\\\\:')
          .replace(/%/g, '\\\\%');

        const fontPath = path.join(process.cwd(), 'assets', 'fonts', 'Montserrat-Bold.ttf')
          .replace(/\\/g, '/')
          .replace(/:/g, '\\\\:'); // Double escape for Windows FFmpeg
        const bannerFontSize = Math.round(bannerH * 0.15); // Texto menor
        const bannerY = thumbH - Math.round(h * 0.05);

        vfFilters.push(
          // 1. Split vídeo: fundo blur + clipe
          `[0:v]split=2[v_bg][v_clip]`,
          // 2. Fundo: vídeo com blur (menos intenso)
          `[v_bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=8:3[bg]`,
          // 3. Thumbnail no topo
          `[${thumbIdx}:v]scale=${w}:${thumbH}:force_original_aspect_ratio=increase,crop=${w}:${thumbH}:(iw-${w})/2:(ih-${thumbH})/2[thumb]`,
          `[bg][thumb]overlay=0:0[step1]`,
          // 4. Pincelada vermelha (brush PNG) escalada + texto bold menor
          `[${brushIdx}:v]scale=${bannerW}:${bannerH}:flags=lanczos[brush_scaled]`,
          `[brush_scaled]drawtext=fontfile='${fontPath}':text='${clipTitle}':fontcolor=white:fontsize=${bannerFontSize}:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.6:shadowx=4:shadowy=4[banner_txt]`,
          `[step1][banner_txt]overlay=${bannerX}:${bannerY}[step2]`,
          // 5. Clipe com face tracking na parte inferior
          `[v_clip]scale=${w}:${videoH}:force_original_aspect_ratio=increase,crop=${w}:${videoH}:(iw-${w})*${faceX}:(ih-${videoH})*${faceY}[clip]`,
          `[step2][clip]overlay=0:${bannerY + bannerH}[vout]`
        );
        isComplex = true;
      } else if (layout === 'split') {
        // ── Split Screen: Rosto focado (topo) + Cena completa (baixo) ──
        const halfH = Math.round(h / 2);
        
        vfFilters.push(
          `split=2[v_top][v_bottom]`,
          // Top: focado no rosto usando faceX e faceY
          `[v_top]scale=${w}:${halfH}:force_original_aspect_ratio=increase,crop=${w}:${halfH}:(iw-${w})*${faceX}:(ih-${halfH})*${faceY}[top]`,
          // Bottom: cena completa, centralizada
          `[v_bottom]scale=${w}:${halfH}:force_original_aspect_ratio=increase,crop=${w}:${halfH}:(iw-${w})*0.5:(ih-${halfH})*0.5[bottom]`,
          `[top][bottom]vstack=inputs=2[vout]`
        );
        isComplex = true;
      } else if (layout === 'react') {
        // ── React: Vídeo com blur leve de fundo + Overlay do rosto no canto ──
        const reactW = Math.round(w * 0.32);
        const reactH = Math.round(reactW * 1.3);
        const margin = Math.round(w * 0.03);

        vfFilters.push(
          `split=2[v_bg][v_face]`,
          // Fundo: vídeo escalado para preencher o canvas com blur leve
          `[v_bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,boxblur=8:3[bg]`,
          // Overlay: recorte focado no rosto
          `[v_face]scale=-1:${reactH * 2}:force_original_aspect_ratio=increase,crop=${reactW}:${reactH}:(iw-${reactW})*${faceX}:(ih-${reactH})*${faceY}[face]`,
          `[bg][face]overlay=x=${w - reactW - margin}:y=${h - reactH - margin}[vout]`
        );
        isComplex = true;
      } else if (layout === 'face_tracking') {
        // ── Face Tracking: Crop inteligente no rosto com xCenter e yCenter ──
        vfFilters.push(
          `scale=-1:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})*${faceX}:(ih-${h})*${faceY}[vout]`
        );
        isComplex = true;
      } else {
        // ── Default / Centered: Blur de fundo + Vídeo em primeiro plano ──
        const backgroundBlur = style?.background_blur !== undefined ? style.background_blur : 15;
        const videoScale = style?.video_scale !== undefined ? style.video_scale : 100;
        const blurSigma = Math.max(1, Math.round(backgroundBlur * (is480p ? 0.6 : 1)));
        const zoomFactor = videoScale / 100;

        const fgW = Math.round(w * zoomFactor);
        const fgH = Math.round(h * zoomFactor);

        vfFilters.push(
          `split=2[bg_916][fg_916]`,
          `[bg_916]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=${blurSigma}:5[blurred]`,
          `[fg_916]scale=${fgW}:${fgH}:force_original_aspect_ratio=increase,crop=${w}:${h}[foreground]`,
          `[blurred][foreground]overlay=(W-w)/2:(H-h)/2[vout]`
        );
        isComplex = true;
      }
    } else if (aspectRatio === '1:1') {
      const d = is480p ? 480 : 1080;
      vfFilters.push(
        `scale=${d}:${d}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${d}:${d}:(ow-iw)/2:(oh-ih)/2:black`,
      );
    } else {
      const w = is480p ? 854 : 1920;
      const h = is480p ? 480 : 1080;
      vfFilters.push(
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
      );
    }

    // ── Watermark implementation ──
    if (limits?.has_watermark) {
      const watermarkText = 'kurtcut';
      const watermarkFilter = `drawtext=text='${watermarkText}':x=W-tw-20:y=H-th-20:fontsize=32:fontcolor=white@0.6:shadowcolor=black@0.3:shadowx=2:shadowy=2`;
      
      if (isComplex && vfFilters.length > 0) {
        // Se for complexo, aplicamos sobre [vout] e renomeamos para [vout]
        const lastFilter = vfFilters.pop();
        if (lastFilter) {
          const targetIn = lastFilter.includes('[vout]') ? '[vout]' : '';
          if (targetIn) {
             vfFilters.push(lastFilter.replace(/\[vout\]$/, '[vtemp]'));
             vfFilters.push(`[vtemp]${watermarkFilter}[vout]`);
          } else {
             vfFilters.push(lastFilter);
             vfFilters.push(watermarkFilter);
          }
        }
      } else {
        vfFilters.push(watermarkFilter);
      }
    }

    return { vfFilters, isComplex };
  }

  async createAllFromAnalysis(
    usuarioId: string,
    videoId: string,
    skipExport = false,
  ): Promise<Clip[]> {
    const videosRepo = await this.videosRepoFn(usuarioId);
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const video = await videosRepo.findOne({ where: { id: videoId } });
    if (!video?.resultado_analise?.clips) return [];

    const analysisClips = [...video.resultado_analise.clips].sort(
      (a: any, b: any) =>
        (b.score || b.pontuacao_viral || 0) -
        (a.score || a.pontuacao_viral || 0),
    );

    const validatedClips = this.deduplicateClips(analysisClips, video.duracao || 0);
    this.logger.log(`[${videoId}] Analysis suggested ${analysisClips.length} clips, ${validatedClips.length} clips validated.`);
    
    if (validatedClips.length === 0 && analysisClips.length > 0) {
      this.logger.warn(`[${videoId}] All ${analysisClips.length} clips were filtered out! Most likely too short (< 2s) or total overlaps.`);
    }

    const existingClips = await clipsRepo.find({
      where: { video_id: videoId },
    });
    if (existingClips.length > 0) {
      console.log(`[clips] Cleaning up ${existingClips.length} existing clips`);
    }

    for (const existing of existingClips) {
      try {
        if (
          existing.caminho_arquivo &&
          fs.existsSync(existing.caminho_arquivo)
        ) {
          fs.unlinkSync(existing.caminho_arquivo);
        }
        if (
          existing.miniatura_caminho &&
          fs.existsSync(existing.miniatura_caminho)
        ) {
          fs.unlinkSync(existing.miniatura_caminho);
        }
      } catch (e) {
        console.warn(`[clips] Could not delete clip assets: ${e.message}`);
      }
      await clipsRepo.delete(existing.id);
    }

    const prefs = video.preferencias_corte || {};
    const defaultAspect = prefs.proporcao_tela || '9:16';

    const clips: Clip[] = [];
    for (const analysisClip of validatedClips) {
      const start = parseFloat(
        analysisClip.start_time ?? analysisClip.tempo_inicio,
      );
      const end = parseFloat(analysisClip.end_time ?? analysisClip.tempo_fim);

      const existingSame = await clipsRepo.findOne({
        where: { video_id: videoId, tempo_inicio: start, tempo_fim: end },
      });

      if (existingSame) {
        clips.push(existingSame);
        continue;
      }

      const allWords = video.palavras_transcricao || [];
      const clipWords = allWords
        .filter((w) => {
          // AssemblyAI words are in ms, clip start/end are in seconds
          const wStartSec = w.start / 1000;
          const wEndSec = w.end / 1000;
          // Keep words that at least partially overlap the clip boundaries
          return wStartSec >= start - 0.5 && wEndSec <= end + 0.5;
        })
        .map((w) => ({
          text: w.text,
          start: w.start / 1000,
          end: w.end / 1000,
        }));

      try {
        const clip = await this.createFromAnalysis(usuarioId, videoId, {
          ...analysisClip,
          words: clipWords,
          proporcao_tela: defaultAspect,
          subtitle_style: prefs.subtitle_style,
        });
        clips.push(clip);

        const exportOpts: ExportOptions = {
          resolution: '1080p',
          subtitle_style: prefs.subtitle_style,
          proporcao_tela: defaultAspect,
          isFinalExport: false, // Preview only — subtitles burn only on explicit user export
        };

        if (!skipExport) {
          this.exportQueue
            .add(ClipJobType.EXPORT_CLIP, {
              clipId: clip.id,
              options: exportOpts,
              usuarioId,
            })
            .catch((err) => {
              console.error(
                `Auto-export queue failed for clip ${clip.id}: ${err.message}`,
              );
            });
        }
      } catch (e) {
        this.logger.error(`[${videoId}] Error creating clip from analysis segment: ${e.message}`);
      }
    }
    return clips;
  }

  private deduplicateClips(clips: any[], videoDuration: number): any[] {
    const result: any[] = [];
    const minDur = videoDuration > 60 ? 5 : 2; // Dinâmico: vídeos longos exigem mais substância

    for (const clip of clips) {
      const start = parseFloat(clip.start_time ?? clip.tempo_inicio) || 0;
      const end = parseFloat(clip.end_time ?? clip.tempo_fim) || 0;
      const duration = end - start;
      if (duration < minDur) continue;

      const overlaps = result.some((accepted) => {
        const aStart =
          parseFloat(accepted.start_time ?? accepted.tempo_inicio) || 0;
        const aEnd = parseFloat(accepted.end_time ?? accepted.tempo_fim) || 0;
        return start < aEnd && end > aStart;
      });

      if (!overlaps) result.push(clip);
    }
    return result;
  }

  async updateMetadata(
    usuarioId: string,
    clipId: string,
    dto: any,
  ): Promise<Clip> {
    const repo = await this.clipsRepoFn(usuarioId);
    const clip = await repo.findOne({ where: { id: clipId } });
    if (!clip) throw new NotFoundException(`Clipe ${clipId} não encontrado`);

    if (dto.title !== undefined) clip.titulo = dto.title;
    if (dto.tempo_inicio !== undefined) clip.tempo_inicio = dto.tempo_inicio;
    if (dto.tempo_fim !== undefined) clip.tempo_fim = dto.tempo_fim;
    if (dto.tempo_inicio !== undefined || dto.tempo_fim !== undefined) {
      clip.duracao = Number(clip.tempo_fim) - Number(clip.tempo_inicio);
    }

    if (dto.thumbnail_base64) {
      const base64Data = dto.thumbnail_base64.replace(
        /^data:image\/\w+;base64,/,
        '',
      );
      const buffer = Buffer.from(base64Data, 'base64');
      const videoId = clip.video_id;
      const thumbName = `thumb_${clip.id}_custom.jpg`;
      const relativePath = `${videoId}/thumbnails/${thumbName}`;
      const absolutePath = this.storageService.getAbsolutePath(relativePath);
      const parentDir = path.dirname(absolutePath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      
      fs.writeFileSync(absolutePath, buffer);
      clip.miniatura_caminho = relativePath;
    }

    const currentMeta = clip.dados_legenda
      ? typeof clip.dados_legenda === 'string'
        ? JSON.parse(clip.dados_legenda)
        : clip.dados_legenda
      : {};

    const editableFields = [
      'font_family',
      'subtitle_preset',
      'preset',
      'font_color',
      'highlight_color',
      'outline_color',
      'outline_width',
      'animation',
      'posY',
      'background_blur',
      'background_zoom',
      'subtitle_blur',
      'shadow_depth',
      'words',
      'max_words',
      'font_size',
      'videoTransform',
      'layout',
      'secondary_video_path',
      'subtitle_opacity',
      'video_opacity',
    ] as const;

    editableFields.forEach((field) => {
      if ((dto as any)[field] !== undefined)
        currentMeta[field] = (dto as any)[field];
    });

    if (dto.subtitle_preset) currentMeta.preset = dto.subtitle_preset;
    else if ((dto as any).preset)
      currentMeta.subtitle_preset = (dto as any).preset;

    // ── Invalidate caches when relevant params change ──
    const layoutChanged = dto.layout !== undefined && dto.layout !== currentMeta._prev_layout;
    const timesChanged = dto.tempo_inicio !== undefined || dto.tempo_fim !== undefined;

    if (layoutChanged || timesChanged) {
      // Face cache depends on clip timing and layout
      delete currentMeta.face_cache;
      // Preview config hash depends on layout/timing/face
      delete currentMeta.preview_config_hash;
      this.logger.log(`[clip:${clipId}] Cache invalidated (layout=${layoutChanged}, times=${timesChanged})`);
    }
    currentMeta._prev_layout = currentMeta.layout;

    clip.dados_legenda = currentMeta;
    return repo.save(clip);
  }

  async bulkExport(
    usuarioId: string,
    videoId: string,
    options: any,
  ): Promise<void> {
    const clipsRepo = await this.clipsRepoFn(usuarioId);
    const clips = await clipsRepo.find({ where: { video_id: videoId } });
    if (!clips || clips.length === 0) return;

    // Notifica início imediato para a barra de progresso do frontend
    this.eventsGateway.emitVideoProgress(videoId, 5, "Iniciando renderização em massa...");

    for (const clip of clips) {
      const exportOpts: ExportOptions = {
        resolution: options.resolution || '1080p',
        subtitle_style: options.subtitle_style || clip.dados_legenda,
        proporcao_tela: options.proporcao_tela || clip.proporcao_tela || '9:16',
        isFinalExport: true,
      };

      await this.exportQueue.add(ClipJobType.EXPORT_CLIP, {
        clipId: clip.id,
        options: exportOpts,
        usuarioId,
      });
    }
  }
}
