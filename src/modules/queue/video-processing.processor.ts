import {
  Process,
  Processor,
  OnQueueFailed,
  OnQueueCompleted,
} from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { Job } from 'bull';
import { Video } from '../../entities/video.entity';
import { Corte as Clip } from '../../entities/corte.entity';
import { TenantDbManager } from '../tenant/tenant-db.manager';
import { TranscriptionService } from '../transcription/transcription.service';
import { AnalysisService } from '../analysis/analysis.service';
import { AudioAnalysisService } from '../analysis/audio-analysis.service';
import { ClipsService } from '../clips/clips.service';
import { EventsGateway } from '../gateway/events.gateway';
import { StorageService } from '../../common/storage/storage.service';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
const ffmpegPath = require('ffmpeg-static');

import { 
  VIDEO_QUEUE, 
  CLIP_EXPORT_QUEUE, 
  VideoJobType, 
  ClipJobType 
} from './queue.constants';

@Processor(VIDEO_QUEUE)
export class VideoProcessingProcessor {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private transcriptionService: TranscriptionService,
    private analysisService: AnalysisService,
    private audioAnalysisService: AudioAnalysisService,
    private clipsService: ClipsService,
    private eventsGateway: EventsGateway,
    private tenantDb: TenantDbManager,
    private storageService: StorageService,
  ) {}

  private async getVideosRepo(usuarioId: string) {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Video);
  }

  @Process({ name: VideoJobType.DOWNLOAD_YOUTUBE, concurrency: 2 })
  async handleDownloadYoutube(job: Job<any>) {
    const { videoId, youtubeUrl, preferences, usuarioId } = job.data;
    // Usa diretório temporário local para download do YouTube
    const tempVideoDir = this.storageService.getTempDir(videoId);
    const videoPath = path.join(tempVideoDir, 'video.mp4');

    try {
      await job.progress(5);
      const vRepo = await this.getVideosRepo(usuarioId);
      await vRepo.update(videoId, { status_transcricao: 'processing' });
      this.eventsGateway.emitVideoProgress(videoId, 5, 'Baixando vídeo do YouTube...');

      // Clean URL
      let cleanUrl = youtubeUrl;
      try {
        const urlObj = new URL(youtubeUrl);
        const videoParam = urlObj.searchParams.get('v');
        if (videoParam) cleanUrl = `https://www.youtube.com/watch?v=${videoParam}`;
      } catch { /* keep original */ }

      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

      let cookiesPath = path.join(process.cwd(), 'cookies.txt');
      let hasCookies = fs.existsSync(cookiesPath);
      let isTempCookies = false;

      const envCookies = process.env.YOUTUBE_COOKIES;
      if (envCookies) {
        try {
          const tempCookiesPath = path.join(tempVideoDir, `cookies_${videoId}.txt`);
          let cookiesContent = envCookies;
          
          // Decode if it's base64 (doesn't contain tabs/newlines and looks like base64)
          if (!envCookies.includes('\n') && !envCookies.includes('\t') && envCookies.length > 100) {
            try {
              const decoded = Buffer.from(envCookies.trim(), 'base64').toString('utf-8');
              if (decoded.includes('# Netscape') || decoded.includes('\t')) {
                cookiesContent = decoded;
                this.logger.log(`[${videoId}] Decoded YouTube cookies from Base64`);
              }
            } catch { /* use original */ }
          }
          
          fs.writeFileSync(tempCookiesPath, cookiesContent);
          cookiesPath = tempCookiesPath;
          hasCookies = true;
          isTempCookies = true;
          this.logger.log(`[${videoId}] YouTube cookies written from env variable to: ${tempCookiesPath}`);
        } catch (err) {
          this.logger.error(`[${videoId}] Failed to write cookies from env: ${err.message}`);
        }
      }

      const ytDlp = require('yt-dlp-exec');
      const binPath = path.join(process.cwd(), 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp');
      this.logger.log(`[${videoId}] yt-dlp Path: ${binPath} (Exists: ${fs.existsSync(binPath)})`);
      this.logger.log(`[${videoId}] Using static FFmpeg: ${ffmpegPath}`);

      try {
        await ytDlp(cleanUrl, {
          noPlaylist: true,
          retries: 3,
          cookies: hasCookies ? cookiesPath : undefined,
          userAgent: userAgent,
          extractorArgs: 'youtube:player-client=android',
          format: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
          output: videoPath,
          jsRuntimes: 'node',
          ffmpegLocation: ffmpegPath,
        });
      } finally {
        if (isTempCookies && fs.existsSync(cookiesPath)) {
          try {
            fs.unlinkSync(cookiesPath);
            this.logger.log(`[${videoId}] Cleaned up temporary cookies file`);
          } catch (e) {
            this.logger.warn(`[${videoId}] Failed to cleanup temporary cookies: ${e.message}`);
          }
        }
      }

      if (!fs.existsSync(videoPath)) throw new Error('Download failed');

      // Upload do vídeo baixado para Supabase Storage
      const relativePath = `${videoId}/video.mp4`;
      const videoBuffer = fs.readFileSync(videoPath);
      await this.storageService.uploadFile(relativePath, videoBuffer, 'video/mp4');
      this.logger.log(`[${videoId}] Vídeo do YouTube enviado para Supabase Storage: ${relativePath}`);

      await vRepo.update(videoId, { caminho_arquivo: relativePath });
      await job.progress(30);
      this.eventsGateway.emitVideoProgress(videoId, 30, 'Download concluído. Transcrevendo áudio...');

      // Transcrever usando o arquivo local temporário (mais eficiente que baixar de novo)
      await this.transcribeAndAnalyze(
        usuarioId, videoId, videoPath, job, preferences, job.data.analysisOnly, true // true = limpar arquivo local ao final
      );
    } catch (error) {
      this.logger.error(`[${videoId}] YT download failed: ${error.message}`);
      const vRepo = await this.getVideosRepo(usuarioId);
      await vRepo.update(videoId, {
        status_transcricao: 'error',
        status_analise: 'error',
      });
      this.eventsGateway.emitVideoError(videoId, error.message);
      // Limpar diretório temporário em caso de erro
      this.storageService.cleanupTempDir(tempVideoDir);
      throw error;
    }
  }

  @Process({ name: VideoJobType.PROCESS_UPLOADED, concurrency: 3 })
  async handleProcessUploaded(job: Job<any>) {
    const { videoId, filePath, preferences, usuarioId } = job.data;

    try {
      const vRepo = await this.getVideosRepo(usuarioId);
      await vRepo.update(videoId, { status_transcricao: 'processing' });
      this.eventsGateway.emitVideoProgress(
        videoId,
        10,
        'Iniciando processamento...',
      );
      this.eventsGateway.emitVideoStatusChange(videoId, {
        transcript_status: 'processing',
      });
      await job.progress(10);

      // Baixar do Supabase para diretório temporário local
      const localPath = this.storageService.getTempPath(`${videoId}/${path.basename(filePath)}`);
      this.logger.log(`[${videoId}] Baixando vídeo do Supabase para processamento: ${filePath}`);
      await this.storageService.downloadFile(filePath, localPath);

      await this.transcribeAndAnalyze(
        usuarioId,
        videoId,
        localPath,
        job,
        preferences,
        job.data.analysisOnly,
        true // true = limpar arquivo local ao final
      );
    } catch (error) {
      this.logger.error(`[${videoId}] Processing failed: ${error.message}`);
      const vRepo = await this.getVideosRepo(usuarioId);
      await vRepo.update(videoId, {
        status_transcricao: 'error',
        status_analise: 'error',
      });
      this.eventsGateway.emitVideoError(videoId, error.message);
      throw error;
    }
  }

  private async transcribeAndAnalyze(
    usuarioId: string,
    videoId: string,
    filePath: string,
    job: Job,
    preferences?: any,
    analysisOnly = false,
    cleanupLocal = false
  ) {
    const prefs = preferences || {};
    const doTranscription = prefs.generate_subtitles !== false;

    let transcriptionResult: any = { text: '', words: [] };
    const audioFeaturesPromise = this.audioAnalysisService
      .extractFeatures(filePath)
      .catch(() => null);

    const vRepo = await this.getVideosRepo(usuarioId);

    // ── Step: Transcrição (30% → 65%) ────────────────────────────────────────
    if (doTranscription) {
      // Check if transcription already exists (idempotent)
      const existingVideo = await vRepo.findOne({ where: { id: videoId } });
      if (existingVideo?.status_transcricao === 'completed' && existingVideo.palavras_transcricao?.length > 0 && !job.data.forceTranscription) {
        this.logger.log(`[${videoId}] Transcription already completed (${existingVideo.palavras_transcricao.length} words). Skipping AssemblyAI.`);
        transcriptionResult = {
          id: existingVideo.id_transcricao,
          text: existingVideo.texto_transcricao,
          words: existingVideo.palavras_transcricao,
        };
        await vRepo.update(videoId, { status_analise: 'processing' });
      } else {
        await job.progress(32);
        this.eventsGateway.emitVideoProgress(videoId, 32, 'Transcrevendo áudio com AssemblyAI...');

        transcriptionResult = await this.transcriptionService.transcribe(filePath);

        await vRepo.update(videoId, {
          id_transcricao: transcriptionResult.id,
          texto_transcricao: transcriptionResult.text,
          palavras_transcricao: transcriptionResult.words,
          status_transcricao: 'completed',
          status_analise: 'processing',
        });
      }
      await job.progress(65);
      this.eventsGateway.emitVideoProgress(videoId, 65, 'Transcrição concluída. Analisando com IA...');
      this.eventsGateway.emitVideoStatusChange(videoId, {
        transcript_status: 'completed',
        analysis_status: 'processing',
      });
    } else {
      await vRepo.update(videoId, {
        status_transcricao: 'skipped',
        status_analise: 'processing',
      });
      await job.progress(65);
      this.eventsGateway.emitVideoProgress(videoId, 65, 'Analisando com IA...');
    }

    // ── Step: Análise IA (65% → 85%) ─────────────────────────────────────────
    let audioFeatures = await audioFeaturesPromise;
    const video = await vRepo.findOne({ where: { id: videoId } });

    // Persist audio features no Supabase Storage
    if (audioFeatures) {
      try {
        const audioFeaturesJson = JSON.stringify(audioFeatures, null, 2);
        const audioFeaturesPath = `${videoId}/audio_features.json`;
        await this.storageService.uploadFile(
          audioFeaturesPath,
          Buffer.from(audioFeaturesJson),
          'application/json',
        );
        this.logger.log(`[${videoId}] Audio features saved to Supabase: ${audioFeaturesPath}`);
      } catch (e) {
        this.logger.warn(`[${videoId}] Failed to persist audio features: ${e.message}`);
      }
    }

    // ── Analysis Interval Filtering ──
    let filteredWords = transcriptionResult.words || [];
    let filteredText = transcriptionResult.text || '';
    
    const start = (prefs.analysis_start || 0);
    const end = (prefs.analysis_end || 0) > 0 ? prefs.analysis_end : 0;

    if (start > 0 || end > 0) {
      const startMs = start * 1000;
      const endMs = end > 0 ? end * 1000 : Infinity;

      this.logger.log(`[${videoId}] Filtering analysis interval: ${start}s to ${end > 0 ? end + 's' : 'end'}`);

      // Filter words
      filteredWords = filteredWords.filter(w => w.start >= startMs && w.end <= endMs);
      filteredText = filteredWords.map(w => w.text).join(' ');

      // Filter audio features if present
      if (audioFeatures) {
        if (audioFeatures.energy_peaks) {
          audioFeatures.energy_peaks = audioFeatures.energy_peaks.filter(p => p.timestamp >= start && (end === 0 || p.timestamp <= end));
        }
        if (audioFeatures.silence_segments) {
          audioFeatures.silence_segments = audioFeatures.silence_segments.filter(s => s.start >= start && (end === 0 || s.start <= end));
        }
      }
    }

    let analysis: any;
    if (video?.resultado_analise && !job.data.forceAnalysis) {
      this.logger.log(`[${videoId}] Analysis already exists, skipping.`);
      analysis = video.resultado_analise;
    } else {
      let videoDuration = video?.duracao || 0;
      if (videoDuration === 0 && filteredWords && filteredWords.length > 0) {
        const lastWord = filteredWords[filteredWords.length - 1];
        videoDuration = Math.round((lastWord.end || 0) / 1000);
        // Save duration to DB
        if (videoDuration > 0) {
           const vRepo = await this.getVideosRepo(usuarioId);
           await vRepo.update(videoId, { duracao: videoDuration });
        }
      }
      // Gerar o máximo de clipes possíveis: ~1 clipe a cada 30s de vídeo. Mínimo 5, Máximo 20.
      const clipsToGenerate = Math.max(5, Math.min(20, Math.floor(videoDuration / 30)));
      
      this.logger.log(`[${videoId}] Starting analysis for ${clipsToGenerate} clips (Duration: ${videoDuration}s)`);
      
      analysis = await this.analysisService.analyzeTranscript(
        filteredText,
        filteredWords,
        video?.titulo || 'Video',
        videoDuration,
        audioFeatures,
        clipsToGenerate,
        clipsToGenerate,
        prefs.target_duration,
      );
    }

    const vRepo2 = await this.getVideosRepo(usuarioId);
    await vRepo2.update(videoId, {
      resultado_analise: analysis,
      status_analise: 'completed',
    });
    await job.progress(85);
    this.eventsGateway.emitVideoProgress(videoId, 85, 'Análise concluída. Renderizando clipes...');
    this.eventsGateway.emitVideoStatusChange(videoId, {
      transcript_status: doTranscription ? 'completed' : 'skipped',
      analysis_status: 'completed',
      analysis_result: analysis,
    });

    // ── Step: Renderização (85% → 100%) ──────────────────────────────────────
    try {
      this.logger.log(`[${videoId}] Creating clips from analysis (forcing new clips)...`);
      await this.clipsService.createAllFromAnalysis(usuarioId, videoId, analysisOnly);
      this.eventsGateway.emitClipReady(videoId, { autoGenerated: true, analysisOnly });
    } catch (e) {
      this.logger.warn(`[${videoId}] Auto clip creation failed: ${e.message}`);
    }

    await job.progress(100);
    this.eventsGateway.emitVideoProgress(videoId, 100, 'Processamento concluído!');
    this.logger.log(`[${videoId}] Done.`);

    if (cleanupLocal && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        this.logger.log(`[${videoId}] Cleaned up local temp file: ${filePath}`);
        // Tentar limpar o diretório pai se estiver vazio
        const parentDir = path.dirname(filePath);
        const remaining = fs.readdirSync(parentDir);
        if (remaining.length === 0) {
          fs.rmdirSync(parentDir);
        }
      } catch (e) {
        this.logger.warn(`[${videoId}] Cleanup failed: ${e.message}`);
      }
    }
  }

  @OnQueueFailed() onFailed(job: Job, err: Error) {
    this.logger.error(`Job ${job.name}[${job.id}] failed: ${err.message}`);
  }
  @OnQueueCompleted() onCompleted(job: Job) {
    this.logger.log(`Job ${job.name}[${job.id}] completed`);
  }
}

@Processor(CLIP_EXPORT_QUEUE)
export class ClipExportProcessor {
  private readonly logger = new Logger(ClipExportProcessor.name);
  constructor(
    private clipsService: ClipsService,
    private eventsGateway: EventsGateway,
    private tenantDb: TenantDbManager,
  ) {}

  private async getCortesRepo(usuarioId: string) {
    const ds = await this.tenantDb.getTenantDataSource(usuarioId);
    return ds.getRepository(Clip);
  }

  @Process({ name: ClipJobType.EXPORT_CLIP, concurrency: 2 })
  async handleExportClip(job: Job<any>) {
    const { clipId, options, usuarioId } = job.data;
    try {
      await job.progress(5);
      await this.clipsService.exportClip(usuarioId, clipId, options);
      await job.progress(100);
    } catch (error) {
      if (error.status === 404 || error.message?.toLowerCase().includes('not found')) {
        this.logger.warn(
          `[clip:${clipId}] Exportação ignorada: Clipe não encontrado (foi excluído?).`,
        );
        return; // Sucesso silencioso para não re-tentar na fila um clipe inexistente
      }
      this.logger.error(`[clip:${clipId}] Export failed: ${error.message}`);
      try {
        const cRepo = await this.getCortesRepo(usuarioId);
        await cRepo.update(clipId, { status: 'error' });
      } catch (repoErr) {
        // Ignora erro ao tentar marcar como erro
      }
      throw error;
    }
  }

  @Process({ name: ClipJobType.CLEANUP_TEMP, concurrency: 1 })
  async handleCleanup(job: Job<any>) {
    const maxAge = (job.data.maxAgeHours || 24) * 3600 * 1000;
    const os = require('os');
    const tempDir = path.join(os.tmpdir(), 'kurt-cut-tmp');
    const now = Date.now();
    let cleaned = 0;
    try {
      if (!fs.existsSync(tempDir)) return;
      const entries = fs.readdirSync(tempDir);
      for (const entry of entries) {
        const fullPath = path.join(tempDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAge) {
            if (stat.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
            cleaned++;
          }
        } catch (fileErr) {
          // Skip if file is locked or inaccessible
          continue;
        }
      }
      this.logger.log(`Cleanup: removed ${cleaned} stale temp entries`);
    } catch (e) {
      this.logger.warn(`Cleanup error: ${e.message}`);
    }
  }

  @OnQueueFailed() onFailed(job: Job, err: Error) {
    this.logger.error(`ClipExport job[${job.id}] failed: ${err.message}`);
  }
}
