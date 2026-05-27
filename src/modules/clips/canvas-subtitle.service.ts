import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const ffmpegPath = require('ffmpeg-static');
const execAsync = promisify(exec);
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// ─── Tipagens ─────────────────────────────────────────────────────────────────

/** Representa uma única palavra com metadados de tempo para animação */
interface Word {
  text: string;
  start: number;
  end: number;
}

/** Configurações visuais que definem a aparência da legenda */
interface SubtitleStyle {
  subtitle_preset?: string; // Nome do modelo (ex: tiktok, instagram)
  preset?: string;          // Alias para compatibilidade
  font_family?: string;
  font_size?: number;
  font_color?: string;
  highlight_color?: string;
  outline_color?: string;
  outline_width?: number;
  shadow_depth?: number;
  background_color?: string;
  posY?: number;            // Posição vertical (0-100)
  max_words?: number;       // Máximo de palavras exibidas por vez
}

/** Estrutura interna para gerenciar o estado de cada quadro (frame) renderizado */
interface RenderFrame {
  /** Carimbo de tempo em que este quadro começa a ser exibido */
  startTime: number;
  /** Carimbo de tempo em que este quadro é substituído */
  endTime: number;
  /** Tempo local dentro da duração da palavra (0 = a palavra acabou de aparecer) */
  localT: number;
  /** Lista de palavras que devem ser desenhadas neste quadro */
  words: { text: string; isActive: boolean; isPast: boolean }[];
}

// ─── Utilitários de Auxílio (Helpers) ─────────────────────────────────────────

/**
 * Converte nomes de cores CSS ou RGBA para um formato utilizável no Canvas.
 * Garante que cores transparentes sejam tratadas corretamente.
 */
function parseColor(css: string, fallback = '#FFFFFF'): string {
  if (!css || css === 'transparent') return 'transparent';
  const rgbaMatch = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch) {
    const [, r, g, b, a] = rgbaMatch;
    const alpha = a !== undefined ? parseFloat(a) : 1;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return css || fallback;
}

/** Converte Hexadecimal (#RRGGBB) para RGBA para permitir controle de opacidade */
function hexToRgba(hex: string, alpha = 1): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Retorna uma string de cor no formato HSLA (Matiz, Saturação, Luminosidade, Alfa) */
function hslToStr(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h},${s}%,${l}%,${a})`;
}

/** 
 * Função Matemática de Mola (Spring) 
 * Cria uma animação de "vai e vem" elástico que faz a palavra saltar ao aparecer.
 */
function spring(t: number): number {
  return Math.max(0, 1 - Math.exp(-t * 4) * Math.cos(t * 6));
}

/** Função de Suavização (Ease-Out) — desacelera conforme chega ao final do tempo */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, t), 3);
}

// ─── Main Service ─────────────────────────────────────────────────────────────

@Injectable()
export class CanvasSubtitleService implements OnModuleInit {
  private readonly logger = new Logger(CanvasSubtitleService.name);

  /**
   * Ciclo de vida do NestJS: Executado quando o módulo é inicializado.
   * Usamos este momento para carregar as fontes apenas uma vez na memória.
   */
  onModuleInit() {
    this.registerFonts();
  }

  /**
   * Registra as fontes do diretório assets/fonts no sistema do Canvas.
   * Isso permite que usemos fontes personalizadas no vídeo.
   */
  private registerFonts() {
    let fontsDir = path.resolve(process.cwd(), 'assets', 'fonts');
    if (!fs.existsSync(fontsDir)) {
      fontsDir = path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts');
    }
    if (!fs.existsSync(fontsDir)) {
      fontsDir = path.resolve(__dirname, '..', '..', 'assets', 'fonts');
    }
    if (fs.existsSync(fontsDir)) {
      const files = fs.readdirSync(fontsDir);
      
      const FONT_NAME_MAP: Record<string, string> = {
        'AlfaSlabOne': 'Alfa Slab One',
        'Anton': 'Anton',
        'ArialBlack': 'Arial Black',
        'Bangers': 'Bangers',
        'BebasNeue': 'Bebas Neue',
        'BlackOpsOne': 'Black Ops One',
        'Bungee': 'Bungee',
        'FredokaOne': 'Fredoka One',
        'Lobster': 'Lobster',
        'Monoton': 'Monoton',
        'Montserrat': 'Montserrat',
        'Orbitron': 'Orbitron',
        'Oswald': 'Oswald',
        'Pacifico': 'Pacifico',
        'PatrickHand': 'Patrick Hand',
        'PressStart2P': 'Press Start 2P',
        'Righteous': 'Righteous',
        'RussoOne': 'Russo One',
        'Staatliches': 'Staatliches',
        'Ultra': 'Ultra'
      };

      for (const f of files) {
        if (!/\.(ttf|otf|woff2?)$/i.test(f)) continue;
        
        const fullPath = path.join(fontsDir, f);
        const baseName = f.split('.')[0]
          .replace(/-Bold$/i, '')
          .replace(/-Regular$/i, '')
          .replace(/-Italic$/i, '')
          .replace(/-Black$/i, '')
          .replace(/-Light$/i, '')
          .replace(/-Medium$/i, '');
        
        // Use mapped name if available, otherwise use basename
        const alias = FONT_NAME_MAP[baseName] || baseName;
          
        try {
          GlobalFonts.registerFromPath(fullPath, alias);
          this.logger.log(`[CanvasFonts] Registered font: "${alias}" from ${f}`);
        } catch (err) {
          this.logger.error(`[CanvasFonts] Failed to register ${f}: ${err.message}`);
        }
      }
    } else {
      this.logger.warn(`[CanvasFonts] Fonts directory not found at: ${fontsDir}`);
    }
  }

  // FONT_SCALE: Matches FFmpegSubtitleService scale.
  // slider 8 → 40px (3.7% of 1080), slider 20 → 100px (9.3%), slider 40 → 200px (18.5%)
  private readonly FONT_SCALE = 5;
  // Taxa de quadros para a animação das legendas. (30 FPS é o ideal).
  private readonly ANIM_FPS = 30;

  /**
   * Ponto de entrada: Desenha legendas no vídeo usando quadros PNG.
   */
  async burnSubtitles(opts: {
    inputVideoPath: string;
    outputPath: string;
    words: Word[];
    subtitleStyle: SubtitleStyle;
    durationSec: number;
    fps?: number;
    width?: number;
    height?: number;
    onProgress?: (p: number) => void;
  }): Promise<void> {
    const {
      inputVideoPath, outputPath, words, subtitleStyle,
      durationSec, width = 1080, height = 1920,
    } = opts;

    if (!words || words.length === 0) {
      fs.copyFileSync(inputVideoPath, outputPath);
      return;
    }

    const preset = (subtitleStyle.subtitle_preset || subtitleStyle.preset || 'tiktok').toLowerCase();
    const maxWords = subtitleStyle.max_words !== undefined ? Number(subtitleStyle.max_words) : 2;
    const rawFontSize = subtitleStyle.font_size !== undefined ? Number(subtitleStyle.font_size) : 8;
    const fontSizePx = Math.round(rawFontSize * this.FONT_SCALE);
    const posY = subtitleStyle.posY !== undefined ? Number(subtitleStyle.posY) : 82;

    this.logger.log(`[Canvas] preset=${preset} fontSizePx=${fontSizePx} maxWords=${maxWords}`);

    const workDir = path.dirname(outputPath);
    const runId = path.basename(outputPath, '.mp4');
    const framesDir = path.join(workDir, `frames_${runId}`);

    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

    try {
      // ── 1. Agrupamento de Palavras ──────────────────────────────────────────
      const SYNC_OFFSET = -0.08;
      const validWords = words.filter(w => w.text.trim().length > 0);
      const synced = validWords.map(w => ({
        ...w,
        start: Math.max(0, w.start + SYNC_OFFSET),
        end: Math.max(0, w.end + SYNC_OFFSET),
      }));

      const groups: { start: number; end: number; words: typeof synced }[] = [];
      for (let i = 0; i < synced.length; i += maxWords) {
        const g = synced.slice(i, i + maxWords);
        groups.push({ start: g[0].start, end: g[g.length - 1].end, words: g });
      }
      for (let i = 0; i < groups.length; i++) {
        groups[i].end = groups[i + 1] ? groups[i + 1].start : groups[i].end + 1.5;
      }

      // ── 2. Geração de Quadros PNG ──────────────────────────────────────────
      const frameStep = 1 / this.ANIM_FPS;
      const overlayEntries: { file: string; start: number; end: number }[] = [];

      let frameIndex = 0;
      const estimatedTotalFrames = Math.max(1, Math.ceil(durationSec * this.ANIM_FPS));

      for (let gi = 0; gi < groups.length; gi++) {
        // Yield to event loop every 10 groups to prevent Bull stalling
        if (gi % 10 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }

        // Emit progress periodically
        if (opts.onProgress && gi % 2 === 0) {
          const p = Math.min(99, Math.round((frameIndex / estimatedTotalFrames) * 100));
          opts.onProgress(p);
        }
        const group = groups[gi];
        const activeSlots: { wordIdx: number; start: number; end: number }[] = [];

        if (maxWords === 1) {
          activeSlots.push({ wordIdx: 0, start: group.start, end: group.end });
        } else {
          for (let wi = 0; wi < group.words.length; wi++) {
            const w = group.words[wi];
            const nextW = group.words[wi + 1];
            activeSlots.push({
              wordIdx: wi,
              start: Math.max(group.start, w.start),
              end: nextW ? nextW.start : group.end,
            });
          }
        }

        for (const slot of activeSlots) {
          const slotDur = slot.end - slot.start;
          const isStatic = ['tiktok', 'impact', 'cinematic'].includes(preset);
          const computedAnimDur = isStatic ? Math.min(0.3, slotDur) : slotDur;
          const animFrameCount = Math.ceil(computedAnimDur * this.ANIM_FPS);

          for (let fi = 0; fi < animFrameCount; fi++) {
            const localT = fi * frameStep;
            const frameTime = slot.start + localT;
            const nextFrameTime = slot.start + (fi + 1) * frameStep;

            const wordStates = group.words.map((w, idx) => ({
              text: w.text,
              isActive: idx === slot.wordIdx,
              isPast: maxWords > 1 && idx < slot.wordIdx,
            }));

            const fileName = `frame_${String(frameIndex).padStart(6, '0')}.png`;
            const filePath = path.join(framesDir, fileName);

            await this.renderFrame({
              canvas: createCanvas(width, height),
              words: wordStates,
              preset,
              fontSizePx,
              posY,
              width,
              height,
              localT,
              slotDur,
              subtitleStyle,
              outputPath: filePath,
            });

            overlayEntries.push({
              file: filePath,
              start: frameTime,
              end: Math.min(nextFrameTime, slot.end),
            });

            frameIndex++;
          }

          const settledStart = slot.start + animFrameCount * frameStep;
          if (settledStart < slot.end - 0.01) {
            const wordStates = group.words.map((w, idx) => ({
              text: w.text,
              isActive: idx === slot.wordIdx,
              isPast: maxWords > 1 && idx < slot.wordIdx,
            }));

            const fileName = `frame_${String(frameIndex).padStart(6, '0')}.png`;
            const filePath = path.join(framesDir, fileName);

            await this.renderFrame({
              canvas: createCanvas(width, height),
              words: wordStates,
              preset,
              fontSizePx,
              posY,
              width,
              height,
              localT: slotDur,
              slotDur,
              subtitleStyle,
              outputPath: filePath,
            });

            overlayEntries.push({
              file: filePath,
              start: settledStart,
              end: slot.end,
            });

            frameIndex++;
          }
        }
      }

      this.logger.log(`[Canvas] Gerados ${frameIndex} quadros PNG`);

      // ── 3. Construção do comando FFmpeg para sobreposição ─────────────────
      const concatFile = path.join(workDir, `concat_${runId}.txt`);
      const overlayVideo = path.join(workDir, `overlay_${runId}.mov`);

      overlayEntries.sort((a, b) => a.start - b.start);

      const lines: string[] = [];
      let cursor = 0;
      const transparentPng = path.join(workDir, `transparent_${runId}.png`);
      {
        const c = createCanvas(width, height);
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        const buffer = await c.encode('png');
        await fs.promises.writeFile(transparentPng, buffer);
      }

      for (const entry of overlayEntries) {
        if (entry.start > cursor + 0.001) {
          lines.push(`file '${transparentPng.replace(/\\/g, '/')}'`);
          lines.push(`duration ${(entry.start - cursor).toFixed(6)}`);
        }
        const dur = Math.max(0.001, entry.end - entry.start);
        lines.push(`file '${entry.file.replace(/\\/g, '/')}'`);
        lines.push(`duration ${dur.toFixed(6)}`);
        cursor = entry.end;
      }

      if (cursor < durationSec - 0.001) {
        lines.push(`file '${transparentPng.replace(/\\/g, '/')}'`);
        lines.push(`duration ${(durationSec - cursor).toFixed(6)}`);
      }

      if (overlayEntries.length > 0) {
        const last = overlayEntries[overlayEntries.length - 1];
        lines.push(`file '${last.file.replace(/\\/g, '/')}'`);
      }

      fs.writeFileSync(concatFile, lines.join('\n'), 'utf-8');

      // ── 4. Converte a sequência de PNGs em um vídeo overlay transparente ──
      const useGpu = process.env.USE_GPU === 'true';

      const overlayCmd = [
        `"${ffmpegPath}"`, '-y', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0',
        '-i', `"${concatFile}"`,
        '-vf', 'fps=30',
        '-c:v', 'qtrle',
        '-pix_fmt', 'argb',
        `"${overlayVideo}"`,
      ].join(' ');

      this.logger.log(`[Canvas] Construindo vídeo de sobreposição (overlay)...`);
      await execAsync(overlayCmd, { timeout: 300000, cwd: workDir });

      // ── 5. Composita o overlay sobre o vídeo de entrada ───────────────────
      const compositeCmd = [
        `"${ffmpegPath}"`, '-y', '-loglevel', 'error',
        '-i', `"${path.basename(inputVideoPath)}"`,
        '-i', `"${path.basename(overlayVideo)}"`,
        '-filter_complex', '"[0:v][1:v]overlay=0:0:shortest=1[vout]"',
        '-map', '"[vout]"', '-map', '0:a?', '-sn',
        useGpu
          ? '-c:v h264_nvenc -preset p4 -cq 18'
          : '-c:v libx264 -preset fast -crf 18',
        '-profile:v high',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        `"${path.basename(outputPath)}"`,
      ].join(' ');

      this.logger.log(`[Canvas] Compositando legendas no vídeo final...`);
      await execAsync(compositeCmd, { timeout: 420000, cwd: workDir });

      this.logger.log(`[Canvas] Concluído → ${outputPath}`);

    } finally {
      try {
        const workDir2 = path.dirname(outputPath);
        const runId2 = path.basename(outputPath, '.mp4');
        const framesDir2 = path.join(workDir2, `frames_${runId2}`);
        const concatFile2 = path.join(workDir2, `concat_${runId2}.txt`);
        const overlayVideo2 = path.join(workDir2, `overlay_${runId2}.mov`);
        const transparentPng2 = path.join(workDir2, `transparent_${runId2}.png`);

        if (fs.existsSync(framesDir2)) fs.rmSync(framesDir2, { recursive: true, force: true });
        if (fs.existsSync(concatFile2)) fs.unlinkSync(concatFile2);
        if (fs.existsSync(overlayVideo2)) fs.unlinkSync(overlayVideo2);
        if (fs.existsSync(transparentPng2)) fs.unlinkSync(transparentPng2);
      } catch {}
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Renderizador de Quadro — desenha um único PNG com a animação correta
  // ──────────────────────────────────────────────────────────────────────────

  private async renderFrame(opts: {
    canvas: any;
    words: { text: string; isActive: boolean; isPast: boolean }[];
    preset: string;
    fontSizePx: number;
    posY: number;
    width: number;
    height: number;
    localT: number;
    slotDur: number;
    subtitleStyle: SubtitleStyle;
    outputPath: string;
  }): Promise<void> {
    const { canvas, words, preset, fontSizePx, posY, width, height, localT, slotDur, subtitleStyle, outputPath } = opts;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, width, height);

    const PRESET_CONFIGS: Record<string, { font?: string; color: string; highlight: string; outline?: string; outlineW?: number; shadow?: number; bgColor?: string }> = {
      // Originais
      tiktok: { font: 'Montserrat', color: '#FFFF00', highlight: '#FFFF00', outline: '#000000', outlineW: 4 },
      highlight: { font: 'Montserrat', color: '#FFFFFF', highlight: '#F7C204', outline: '#000000', outlineW: 0, shadow: 2 },
      karaoke: { font: 'Montserrat', color: '#FFFFFF', highlight: '#00FF00' },
      capcut: { font: 'Montserrat', color: '#000000', highlight: '#FFE500', bgColor: '#FFE500' },
      instagram: { font: 'Montserrat', color: '#DD2A7B', highlight: '#F58529' },
      cinematic: { font: 'Staatliches', color: '#FFFFFF', highlight: '#FFFFFF' },
      impact: { font: 'Montserrat', color: '#FF3B3B', highlight: '#FFFFFF', outline: '#000000', outlineW: 3, shadow: 2 },
      // Clássicos
      neon: { font: 'Monoton', color: '#FFFFFF', highlight: '#FF00FF' },
      matrix: { font: 'Press Start 2P', color: '#00FF00', highlight: '#FFFFFF' },
      pop3d: { font: 'Black Ops One', color: '#FFAA00', highlight: '#FFFFFF' },
      liquid: { font: 'Ultra', color: '#CCCCCC', highlight: '#FFFFFF' },
      explosive: { font: 'Bangers', color: '#FF4400', highlight: '#FFCC00' },
      neonglow: { font: 'Monoton', color: '#00FF88', highlight: '#FFFFFF' },
      glitch: { font: 'Bangers', color: '#FFFFFF', highlight: '#FF00FF' },
      fire: { font: 'Anton', color: '#FFAA00', highlight: '#FFFFFF' },
      water: { font: 'Pacifico', color: '#00FFFF', highlight: '#FFFFFF' },
      rainbow: { font: 'Bungee', color: '#FF6060', highlight: '#FFFFFF' },
      shadow: { font: 'Alfa Slab One', color: '#FFAA00', highlight: '#FFFFFF' },
      pixel: { font: 'Press Start 2P', color: '#FFFF00', highlight: '#FFFFFF' },
      retro: { font: 'Lobster', color: '#FF88CC', highlight: '#FFFFFF' },
      gradientorig: { font: 'Orbitron', color: '#00FFFF', highlight: '#FFFFFF' },
      gradient: { font: 'Orbitron', color: '#00FFFF', highlight: '#FFFFFF' },
      gradientcup: { font: 'Fredoka One', color: '#FF00AA', highlight: '#FFFFFF' },
      outline: { font: 'Anton', color: '#FFFFFF', highlight: '#FFFC00' },
      chrome: { font: 'Black Ops One', color: '#CCCCCC', highlight: '#FFFFFF' },
      glass: { font: 'Righteous', color: '#FFFFFF', highlight: '#FFFFFF' },
      // Novos 2025
      bouncycolor: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFE500' },
      wordbyword: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFE500' },
      highlightbox: { font: 'Montserrat', color: '#000000', highlight: '#000000', bgColor: '#FF6B6B' },
      splitflap: { font: 'Courier New', color: '#FFE500', highlight: '#FFE500', bgColor: '#111111' },
      scramble: { font: 'Courier New', color: '#FFFFFF', highlight: '#00FFFF' },
      firetext: { font: 'Impact', color: '#FFAA00', highlight: '#FFFFFF' },
      rainbowwave: { font: 'Montserrat', color: '#FF6060', highlight: '#FFFFFF' },
      threed: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      bubble: { font: 'Montserrat', color: '#111111', highlight: '#111111', bgColor: '#FFFFFF' },
      countdown: { font: 'Impact', color: '#FFFFFF', highlight: '#FF6B6B' },
      slideinleft: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      stamp: { font: 'Impact', color: '#FF3B3B', highlight: '#FF3B3B' },
      holographic: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FF88FF' },
      gradshift: { font: 'Montserrat', color: '#FFFFFF', highlight: '#C084FC' },
      shadowdepth: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      zoombeat: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      outlineflash: { font: 'Impact', color: '#FFE500', highlight: '#FFE500' },
      sticker: { font: 'Montserrat', color: '#000000', highlight: '#000000', bgColor: '#FFE500' },
      morph: { font: 'Montserrat', color: '#4ECDC4', highlight: '#A855F7' },
      stackreveal: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      liquidflow: { font: 'Montserrat', color: '#4ECDC4', highlight: '#44CF6C' },
      pixelreveal: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      cassette: { font: 'Courier New', color: '#2D2D2D', highlight: '#E63946', bgColor: '#F5F0E8' },
      bouncywords: { font: 'Montserrat', color: '#FF6B6B', highlight: '#FFE66D' },
      terminal: { font: 'Courier New', color: '#FFFFFF', highlight: '#27C93F', bgColor: '#1E1E1E' },
      slicereveal: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      chalkboard: { font: 'Patrick Hand', color: '#F0ECD8', highlight: '#FFFFFF', bgColor: '#2D5A3D' },
      punchtext: { font: 'Impact', color: '#FFFFFF', highlight: '#FFFFFF' },
      newsticker: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF', bgColor: '#E63946' },
      particles: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFE500' },
      noise: { font: 'Montserrat', color: '#FFFFFF', highlight: '#FFFFFF' },
      strokepop: { font: 'Bangers', color: '#111111', highlight: '#FFFFFF', outline: '#FFFFFF', outlineW: 4 },
    };

    const pc = PRESET_CONFIGS[preset] || { color: '#FFFFFF', highlight: '#FFE500' };
    
    const fontColor = parseColor(subtitleStyle.font_color || pc.color || '#FFFFFF');
    const highlightColor = parseColor(subtitleStyle.highlight_color || pc.highlight || '#FFE500');
    const outlineColor = parseColor(subtitleStyle.outline_color || pc.outline || '#000000');
    const outlineWidth = subtitleStyle.outline_width !== undefined ? Number(subtitleStyle.outline_width) : (pc.outlineW ?? 2);
    const bgColor = parseColor(subtitleStyle.background_color || pc.bgColor || 'transparent');
    const fontFamily = subtitleStyle.font_family || pc.font || 'Montserrat';

    const baseY = Math.round(height * (posY / 100));
    // Set font base
    ctx.font = `${fontSizePx}px '${fontFamily}', 'Arial Black', sans-serif`;

    const wordTexts = words.map(w => w.text.toUpperCase());
    const spaces = words.length - 1;
    const spaceWidth = ctx.measureText(' ').width;

    let totalWidth = spaceWidth * spaces;
    const wordWidths: number[] = [];
    for (const t of wordTexts) {
      const m = ctx.measureText(t);
      wordWidths.push(m.width);
      totalWidth += m.width;
    }

    let cursorX = (width - totalWidth) / 2;

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      const text = wordTexts[wi];
      const isActive = word.isActive;
      const isPast = word.isPast;
      const ww = wordWidths[wi];
      const cx = cursorX + ww / 2;

      ctx.save();
      ctx.translate(cx, baseY);
      this.drawWord(ctx, text, preset, isActive, isPast, localT, {
        fontSizePx, fontColor, highlightColor, outlineColor, outlineWidth, bgColor, fontFamily, wordWidth: ww, slotDur,
      });
      ctx.restore();
      cursorX += ww + spaceWidth;
    }

    const buffer = await canvas.encode('png');
    await fs.promises.writeFile(outputPath, buffer);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Desenho por Palavra — Espelha exatamente o motor de animação do frontend
  // ──────────────────────────────────────────────────────────────────────────

  private drawWord(
    ctx: any,
    text: string,
    preset: string,
    isActive: boolean,
    isPast: boolean,
    t: number,
    cfg: {
      fontSizePx: number;
      fontColor: string;
      highlightColor: string;
      outlineColor: string;
      outlineWidth: number;
      bgColor: string;
      fontFamily: string;
      wordWidth: number;
      slotDur: number;
    },
  ): void {
    const { fontSizePx, fontColor, highlightColor, outlineColor, outlineWidth, bgColor, fontFamily, wordWidth, slotDur } = cfg;

    const drawText = (
      text: string,
      color: string,
      strokeColor?: string,
      strokeW?: number,
      shadowColor?: string,
      shadowBlur?: number,
      shadowX = 0,
      shadowY = 0,
    ) => {
      // Clear shadow state completely before each draw to prevent "ghosting" or "blur"
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      if (shadowColor && shadowBlur) {
        ctx.shadowColor = shadowColor;
        ctx.shadowBlur = shadowBlur;
        ctx.shadowOffsetX = shadowX;
        ctx.shadowOffsetY = shadowY;
      }
      if (strokeColor && strokeW && strokeColor !== 'transparent' && strokeW > 0) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeW * 2;
        ctx.lineJoin = 'round';
        ctx.strokeText(text, 0, 0);
      }
      ctx.fillStyle = color;
      ctx.fillText(text, 0, 0);
      // Double fill to ensure maximum color density and cover any sub-pixel stroke artifacts
      ctx.fillText(text, 0, 0);
      
      // Reset after drawing
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    };

    const applyGradientText = (stops: [number, string][], angle = 135) => {
      const rad = (angle * Math.PI) / 180;
      const hw = wordWidth / 2 + 10;
      const hh = fontSizePx / 2 + 4;
      const x1 = -Math.cos(rad) * hw;
      const y1 = -Math.sin(rad) * hh;
      const x2 = Math.cos(rad) * hw;
      const y2 = Math.sin(rad) * hh;
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      for (const [pos, color] of stops) grad.addColorStop(pos, color);
      return grad;
    };

    const fontStr = `bold ${fontSizePx}px '${fontFamily}', 'Arial Black', sans-serif`;
    ctx.font = fontStr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const applyScale = (sx: number, sy = sx) => {
      ctx.transform(sx, 0, 0, sy, 0, 0);
    };

    const applyRotate = (deg: number) => {
      ctx.rotate((deg * Math.PI) / 180);
    };

    switch (preset) {

      // ── Highlight / Hormozi ─────────────────────────────────────────────
      case 'highlight': {
        // Hormozi Style: Pop + tilt active, Gray inactive
        const sp = spring(t * 3.5);
        const textToDraw = text.toUpperCase();

        if (isActive) {
          const sc = 1 + sp * 0.15;
          const rot = (1 - sp) * -4 * (Math.PI / 180);
          ctx.rotate(rot);
          ctx.scale(sc, sc);
          drawText(textToDraw, '#f7c204', undefined, 0, 'rgba(0,0,0,1)', 6, 3, 4);
        } else {
          ctx.globalAlpha = 0.5;
          ctx.scale(0.95, 0.95);
          drawText(textToDraw, 'rgba(180,180,180,0.5)', undefined, 0, 'rgba(0,0,0,0.6)', 3, 2, 2);
          ctx.globalAlpha = 1;
        }
        break;
      }

      // ── TikTok ────────────────────────────────────────────────────────────
      case 'tiktok': {
        const ow = Math.max(1, (fontSizePx / 100) * 1.5); // Thinner sharp stroke
        // Sharp black outline + Soft drop shadow (shadowBlur: 6, offsets: 2)
        drawText(text, '#FFFF00', '#000000', ow, 'rgba(0,0,0,0.6)', 6, 2, 2);
        break;
      }

      // ── Karaoke ───────────────────────────────────────────────────────────
      case 'karaoke': {
        const fillDur = slotDur || 0.4;
        const fillPct = isPast ? 1 : isActive ? Math.min(1, t / fillDur) : 0;
        ctx.globalAlpha = 0.45;
        drawText(text, 'rgba(255,255,255,0.3)');
        ctx.globalAlpha = 1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(-wordWidth / 2 - 4, -fontSizePx, (wordWidth + 8) * fillPct, fontSizePx * 2);
        ctx.clip();
        drawText(text, '#00FF00');
        ctx.restore();
        break;
      }

      // ── Instagram ─────────────────────────────────────────────────────────
      case 'instagram': {
        const sp = spring(t * 3);

        if (isActive) {
          // Bounce: word jumps up then settles
          const bounce = (1 - sp) * (fontSizePx * -0.15);
          const sc = 1 + sp * 0.08;
          ctx.translate(0, bounce);
          ctx.scale(sc, sc);

          // Vivid IG gradient fill
          const stops: [number, string][] = [
            [0, '#ff8a2b'], [0.33, '#e5156b'], [0.66, '#9b30ff'], [1, '#4f5bd5']
          ];
          const igGrad = applyGradientText(stops, 90);
          drawText(text, igGrad, 'rgba(0,0,0,0.15)', 1, 'rgba(0,0,0,0.5)', 8, 0, 3);
        } else {
          // Inactive: dim muted gray
          ctx.globalAlpha = 0.45;
          ctx.scale(0.95, 0.95);
          drawText(text, 'rgba(180,180,180,0.5)', undefined, 0, 'rgba(0,0,0,0.3)', 4, 0, 1);
          ctx.globalAlpha = 1;
        }
        break;
      }

      // ── CapCut ────────────────────────────────────────────────────────────
      case 'capcut': {
        const bw = wordWidth + fontSizePx * 1.0;
        const bh = fontSizePx * 1.3;
        const rr = fontSizePx * 0.4;
        const isActiveCap = isActive || isPast;
        ctx.fillStyle = isActiveCap ? highlightColor : "rgba(40,40,40,0.8)";
        ctx.roundRect(-bw/2, -bh/2, bw, bh, rr);
        ctx.fill();
        const isLight = highlightColor === "#FFE500" || highlightColor === "#FFFFFF";
        const color = isActiveCap ? (isLight ? "#000000" : "#FFFFFF") : "rgba(255,255,255,0.5)";
        drawText(text, color);
        break;
      }

      // ── Impact ────────────────────────────────────────────────────────────
      case 'impact': {
        const sc = isActive ? 1.2 - easeOut(t * 2) * 0.05 : 1;
        const rot = isActive ? Math.sin(t * 3) * 3 : 0;
        applyScale(sc);
        applyRotate(rot);
        const glowBlur = isActive ? 10 + Math.sin(t * 4) * 4 : 0;
        // Use hard shadow instead of blur for active if requested, or keep glow but sharper
        drawText(text, isActive ? highlightColor : fontColor, outlineColor, outlineWidth,
          isActive ? fontColor : undefined, isActive ? glowBlur : 0);
        break;
      }

      // ── Gradient ─────────────────────────────────────────────────────────
      case 'gradient':
      case 'gradientorig': {
        const hue = (t * 120) % 360;
        const sc = isActive ? 1 + spring(t * 2) * 0.05 : 0.9;
        applyScale(sc);
        const grad = applyGradientText([
          [0, hslToStr(hue, 100, 60)],
          [0.5, hslToStr((hue + 120) % 360, 100, 60)],
          [1, hslToStr((hue + 240) % 360, 100, 60)],
        ], 135);
        ctx.fillStyle = grad;
        ctx.fillText(text, 0, 0);
        break;
      }

      // ── Cinematic ─────────────────────────────────────────────────────────
      case 'cinematic': {
        const alpha = isActive ? Math.min(1, t * 4) : 0.7;
        const bw = wordWidth + fontSizePx * 1.5;
        const bh = fontSizePx * 1.6;
        ctx.fillStyle = bgColor !== 'transparent' ? bgColor : `rgba(0,0,0,0.8)`;
        ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
        ctx.globalAlpha = alpha;
        if (isActive) {
          ctx.shadowColor = highlightColor;
          ctx.shadowBlur = 8 + Math.sin(t * 4) * 3;
        }
        ctx.fillStyle = fontColor;
        ctx.font = `bold ${fontSizePx}px '${fontFamily}', sans-serif`;
        ctx.letterSpacing = `${fontSizePx * 0.12}px`;
        ctx.fillText(text, 0, 0);
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        break;
      }

      case 'neon': {
        const oX = isActive ? Math.sin(t * 5) * 3 : 0;
        const oY = isActive ? Math.cos(t * 4) * 2 : 0;
        ctx.translate(oX, oY);

        if (isActive) {
          // Vibrancy optimization: use screen mode for the glitch layers
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          
          // Draw Magenta shift (Left)
          ctx.fillStyle = '#ff00ff';
          ctx.fillText(text, -5, 0);
          
          // Draw Cyan shift (Right) - Draw later to be "on top" if overlapping
          ctx.fillStyle = '#00ffff';
          ctx.fillText(text, 5, 0);
          
          ctx.restore();

          // Main text with subtle glow to not wash out the glitch colors
          drawText(text, fontColor, outlineColor, outlineWidth, highlightColor, 12 + Math.sin(t * 6) * 4);
        } else {
          // Muted state
          drawText(text, fontColor, outlineColor, outlineWidth, highlightColor, 6);
        }
        break;
      }

      // ── Matrix ────────────────────────────────────────────────────────────
      case 'matrix': {
        const alpha = isActive ? 0.5 + Math.sin(t * 5) * 0.5 : 0.4;
        const glowSize = isActive ? 10 + Math.sin(t * 4) * 4 : 6;
        const sc = isActive ? 1 + Math.sin(t * 4) * 0.02 : 1;
        applyScale(sc);
        const bw = wordWidth + fontSizePx;
        const bh = fontSizePx * 1.5;
        ctx.fillStyle = `rgba(0,255,0,${isActive ? 0.15 : 0.05})`;
        ctx.roundRect(-bw / 2, -bh / 2, bw, bh, 4);
        ctx.fill();
        drawText(text, `rgba(0,255,0,${alpha})`, undefined, 0, '#00FF00', glowSize);
        break;
      }

      // ── Pop3D ─────────────────────────────────────────────────────────────
      case 'pop3d': {
        const sc = isActive ? 1 + spring(t * 3) * 0.15 : 1;
        applyScale(sc);
        for (let i = 5; i >= 1; i--) {
          ctx.fillStyle = outlineColor;
          ctx.fillText(text, i, i);
        }
        drawText(text, isActive ? highlightColor : fontColor, outlineColor, outlineWidth);
        break;
      }

      // ── Liquid Metal ─────────────────────────────────────────────────────
      case 'liquid': {
        const hue = (t * 90) % 360;
        const w1 = isActive ? Math.sin(t * 3) * 4 : 0;
        const w2 = isActive ? Math.cos(t * 2.5) * 3 : 0;
        ctx.translate(w2, w1 * 0.5);
        if (isActive) {
          ctx.shadowColor = 'rgba(180,180,255,0.6)';
          ctx.shadowBlur = 6;
        }
        const grad = applyGradientText([
          [0, '#cccccc'], [0.3, '#ffffff'],
          [0.6, hslToStr(hue, 60, 80)], [1, '#999999'],
        ], 90 + w1 * 5);
        ctx.fillStyle = grad;
        ctx.fillText(text, 0, 0);
        ctx.shadowBlur = 0;
        break;
      }

      // ── Explosive ────────────────────────────────────────────────────────
      case 'explosive': {
        const sc = isActive ? 1 + Math.abs(Math.sin(t * 4)) * 0.3 : 1;
        const rot = isActive ? Math.sin(t * 4) * 4 : 0;
        const hue = (t * 180) % 360;
        applyScale(sc);
        applyRotate(rot);
        const glowBlur = isActive ? 20 + Math.sin(t * 5) * 8 : 0;
        drawText(text, isActive ? hslToStr(hue, 100, 60) : fontColor,
          outlineColor, outlineWidth, isActive ? hslToStr(hue, 100, 70) : undefined, glowBlur);
        break;
      }

      // ── Neon Glow ─────────────────────────────────────────────────────────
      case 'neonglow': {
        const hue = (t * 120) % 360;
        const glowSize = isActive ? 20 + Math.sin(t * 5) * 8 : 10;
        const sc = isActive ? 1 + spring(t * 2) * 0.05 : 1;
        applyScale(sc);
        ctx.shadowColor = hslToStr(hue, 100, 50);
        ctx.shadowBlur = glowSize * 2.5;
        ctx.fillStyle = hslToStr(hue, 100, 70);
        ctx.fillText(text, 0, 0);
        ctx.shadowBlur = glowSize * 1.8;
        ctx.fillText(text, 0, 0);
        ctx.shadowBlur = glowSize;
        ctx.fillText(text, 0, 0);
        ctx.shadowBlur = 0;
        break;
      }

      // ── Glitch ───────────────────────────────────────────────────────────
      case 'glitch': {
        if (isActive) {
          const gX = Math.sin(t * 9) * 4;
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = '#ff00ff';
          ctx.fillText(text, -gX * 0.8, 0);
          ctx.fillStyle = '#00ffff';
          ctx.fillText(text, gX * 0.8, 0);
          ctx.restore();
        }
        const sk = isActive ? Math.sin(t * 12) * 5 : 0;
        ctx.transform(1, 0, Math.tan((sk * Math.PI) / 180), 1, 0, 0);
        drawText(text, fontColor, outlineColor, outlineWidth,
          highlightColor, isActive ? 15 : 8);
        break;
      }

      // ── Fire ─────────────────────────────────────────────────────────────
      case 'fire':
      case 'firetext': {
        const fl = isActive ? Math.sin(t * 12) * 3 : 0;
        const fl2 = isActive ? Math.cos(t * 9) * 2 : 0;
        const hue = isActive ? 30 + Math.sin(t * 4) * 15 : 30;
        ctx.translate(0, fl);
        ctx.transform(1, 0, Math.tan((fl2 * Math.PI) / 180), 1, 0, 0);
        const fireGrad = applyGradientText([
          [0, hslToStr(hue - 10, 100, 40)],
          [0.5, hslToStr(hue + 10, 100, 60)],
          [1, hslToStr(hue - 10, 100, 40)],
        ], 90);
        drawText(text, fireGrad, '#ff6600', 1, '#ff4500', isActive ? 20 : 10);
        break;
      }

      // ── Water ────────────────────────────────────────────────────────────
      case 'water': {
        const w1 = Math.sin(t * 4) * 5;
        const w2 = Math.cos(t * 3) * 3;
        ctx.translate(w2, w1);
        const waterGrad = applyGradientText([[0, '#00ffff'], [0.5, '#ffffff'], [1, '#00aaff']], 90);
        drawText(text, waterGrad, '#00aaff', 1.5, '#00ffff', isActive ? 15 : 5);
        break;
      }

      // ── Rainbow ────────────────────────────────────────────────────────
      case 'rainbow': {
        const hue = (t * 150) % 360;
        const sc = isActive ? 1 + spring(t * 2) * 0.1 : 1;
        applyScale(sc);
        const rbGrad = applyGradientText([
          [0, hslToStr(hue, 100, 60)],
          [0.5, hslToStr((hue + 180) % 360, 100, 60)],
          [1, hslToStr((hue + 360) % 360, 100, 60)],
        ], 135);
        drawText(text, rbGrad, undefined, 0, hslToStr(hue, 100, 70), isActive ? 18 : 8);
        break;
      }

      // ── Rainbow Wave ────────────────────────────────────────────────────
      case 'rainbowwave': {
        const hue = (t * 150) % 360;
        const sc = isActive ? 1 + spring(t * 2) * 0.1 : 1;
        const ty = isActive ? Math.sin(t * 4) * 6 : 0;
        applyScale(sc);
        ctx.translate(0, ty);
        const rbGradW = applyGradientText([
          [0, hslToStr(hue, 100, 60)],
          [0.33, hslToStr((hue + 60) % 360, 100, 60)],
          [0.66, hslToStr((hue + 120) % 360, 100, 60)],
          [1, hslToStr((hue + 180) % 360, 100, 60)],
        ], 135);
        ctx.shadowColor = hslToStr(hue, 100, 70);
        ctx.shadowBlur = isActive ? 14 + Math.sin(t * 5) * 5 : 0;
        ctx.fillStyle = rbGradW;
        ctx.fillText(text, 0, 0);
        ctx.shadowBlur = 0;
        break;
      }

      // ── Pixel ────────────────────────────────────────────────────────────
      case 'pixel': {
        const sc = isActive ? 1.1 : 1;
        applyScale(sc);
        drawText(text, fontColor, outlineColor, 2, highlightColor, isActive ? 10 : 0);
        break;
      }

      // ── Retro ────────────────────────────────────────────────────────────
      case 'retro': {
        const sc = isActive ? 1 + Math.sin(t * 4) * 0.05 : 1;
        applyScale(sc);
        drawText(text, fontColor, undefined, 0, '#ff44aa', isActive ? 12 : 6, 3, 3);
        break;
      }

      // ── Glass ─────────────────────────────────────────────────────────────
      case 'glass': {
        const alpha = isActive ? Math.min(1, t * 4) : 0.8;
        const bw = wordWidth + fontSizePx * 1.2;
        const bh = fontSizePx * 1.4;
        ctx.globalAlpha = isActive ? 0.08 + Math.sin(t * 2) * 0.03 : 0.05;
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.roundRect(-bw / 2, -bh / 2, bw, bh, 12);
        ctx.fill();
        ctx.globalAlpha = alpha;
        const glassAlpha = 0.55 + (isActive ? Math.sin(t * 3) * 0.2 : 0);
        drawText(text, `rgba(255,255,255,${glassAlpha})`,
          `rgba(255,255,255,${0.6 + Math.sin(t * 2.5) * 0.2})`, outlineWidth,
          'rgba(255,255,255,0.8)', isActive ? 12 + Math.sin(t * 3.5) * 5 : 8);
        ctx.globalAlpha = 1;
        break;
      }

      // ── Novos 2025 ────────────────────────────────────────────────────────
      
      case 'bouncycolor': {
        const sc = isActive ? 1 + spring(t * 3) * 0.2 : 1;
        applyScale(sc);
        const color = isActive ? highlightColor : fontColor;
        drawText(text, color, outlineColor, outlineWidth, 'rgba(0,0,0,0.5)', isActive ? 15 : 0);
        break;
      }

      case 'wordbyword': {
        const alpha = isActive ? Math.min(1, t * 6) : isPast ? 1 : 0;
        ctx.globalAlpha = alpha;
        const sc = isActive ? 0.8 + easeOut(t * 5) * 0.2 : 1;
        applyScale(sc);
        drawText(text, isActive ? highlightColor : fontColor, outlineColor, outlineWidth);
        ctx.globalAlpha = 1;
        break;
      }

      case 'highlightbox': {
        const alpha = isActive ? 1 : isPast ? 1 : 0.3;
        ctx.globalAlpha = alpha;
        if (isActive) {
          const bw = wordWidth + fontSizePx * 0.6;
          const bh = fontSizePx * 1.1;
          ctx.fillStyle = highlightColor;
          ctx.fillRect(-bw/2, -bh/2, bw, bh);
          drawText(text, '#000000');
        } else {
          drawText(text, fontColor, outlineColor, outlineWidth);
        }
        ctx.globalAlpha = 1;
        break;
      }

      case 'splitflap': {
        const bw = wordWidth + fontSizePx * 0.5;
        const bh = fontSizePx * 1.2;
        ctx.fillStyle = '#111111';
        ctx.fillRect(-bw/2, -bh/2, bw, bh);
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 1;
        ctx.strokeRect(-bw/2, -bh/2, bw, bh);
        ctx.beginPath();
        ctx.moveTo(-bw/2, 0); ctx.lineTo(bw/2, 0);
        ctx.stroke();
        if (isActive) {
          const scY = Math.abs(Math.cos(t * 10));
          ctx.transform(1, 0, 0, scY, 0, 0);
        }
        drawText(text, highlightColor);
        break;
      }

      case 'zoombeat': {
        const sc = isActive ? 1 + Math.pow(Math.sin(t * 8), 2) * 0.2 : 1;
        applyScale(sc);
        drawText(text, fontColor, outlineColor, outlineWidth);
        break;
      }

      case 'shadowdepth': {
        const off = isActive ? 4 + Math.sin(t * 4) * 4 : 4;
        drawText(text, fontColor, undefined, 0, outlineColor, 0, off, off);
        break;
      }

      case 'outlineflash': {
        const alpha = isActive ? 0.3 + Math.abs(Math.sin(t * 10)) * 0.7 : 0;
        ctx.strokeStyle = highlightColor;
        ctx.lineWidth = outlineWidth * 1.5;
        ctx.globalAlpha = alpha;
        ctx.strokeText(text, 0, 0);
        ctx.globalAlpha = 1;
        drawText(text, 'transparent', highlightColor, outlineWidth);
        break;
      }

      case 'sticker': {
        const bw = wordWidth + fontSizePx * 0.8;
        const bh = fontSizePx * 1.2;
        ctx.fillStyle = '#FFFFFF';
        ctx.roundRect(-bw/2-2, -bh/2-2, bw+4, bh+4, 8);
        ctx.fill();
        ctx.fillStyle = highlightColor;
        ctx.roundRect(-bw/2, -bh/2, bw, bh, 6);
        ctx.fill();
        drawText(text, '#000000');
        break;
      }

      case 'punchtext': {
        const sc = isActive ? 2 - easeOut(t * 6) * 1 : 1;
        applyScale(sc);
        drawText(text, fontColor, outlineColor, outlineWidth, 'rgba(0,0,0,0.5)', isActive ? 20 : 5);
        break;
      }

      case 'threed': {
        const rotY = isActive ? Math.sin(t * 4) * 30 : 0;
        ctx.transform(Math.cos(rotY * Math.PI / 180), 0, 0, 1, 0, 0);
        for(let i=6; i>0; i--) {
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillText(text, i, i);
        }
        drawText(text, fontColor);
        break;
      }

      case 'bubble': {
        const bw = wordWidth + fontSizePx * 1.2;
        const bh = fontSizePx * 1.5;
        ctx.fillStyle = '#FFFFFF';
        ctx.roundRect(-bw/2, -bh/2, bw, bh, 20);
        ctx.fill();
        // Tail
        ctx.beginPath();
        ctx.moveTo(0, bh/2); ctx.lineTo(-10, bh/2 + 10); ctx.lineTo(10, bh/2);
        ctx.fill();
        drawText(text, '#111111');
        break;
      }

      // ── Clean (Liso) ──────────────────────────────────────────────────────
      case 'clean': {
        const sc = isActive ? 1 + spring(t * 2) * 0.1 : 1;
        applyScale(sc);
        // Pure text, no outline, no shadow
        drawText(text, isActive ? highlightColor : fontColor);
        break;
      }

      default: {
        const sc = isActive ? 1.1 : 1;
        applyScale(sc);
        drawText(text, isActive ? highlightColor : fontColor, outlineColor, outlineWidth);
        break;
      }
    }
  }
}
