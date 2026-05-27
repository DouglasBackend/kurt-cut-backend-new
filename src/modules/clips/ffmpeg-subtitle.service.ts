import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
const ffmpegPath = require('ffmpeg-static');

const execAsync = promisify(exec);

/**
 * FFmpegSubtitleService — Substitui o Remotion para queimar legendas.
 *
 * Gera um arquivo ASS (Advanced SubStation Alpha) a partir das palavras
 * e do estilo do preset, e queima no vídeo usando o filtro `ass` do FFmpeg.
 *
 * IMPORTANTE — Tamanho da fonte:
 *   O slider do editor vai de 8 a 40.
 *   O valor é multiplicado por FONT_SCALE (5) para gerar o tamanho real em pixels
 *   no frame de 1080px de largura. Isso garante que o tamanho visual no editor
 *   (que usa `vw`) corresponda ao tamanho no vídeo renderizado.
 *
 * Performance: ~5-15s para um clipe de 60s (vs 2-5min do Remotion).
 */
@Injectable()
export class FFmpegSubtitleService {
  private readonly logger = new Logger(FFmpegSubtitleService.name);

  // slider 14 → 70px (~3.6% de 1920), slider 20 → 100px (~5.2%), slider 40 → 200px (~10.4%)
  // Visualmente proporcional ao preview CSS (vw sobre a viewport do editor).
  private readonly FONT_SCALE = 5;

  /**
   * Queima legendas no vídeo usando FFmpeg + ASS.
   */
  async burnSubtitles(opts: {
    inputVideoPath: string;
    outputPath: string;
    words: { text: string; start: number; end: number }[];
    subtitleStyle: Record<string, any>;
    durationSec: number;
    fps?: number;
    width?: number;
    height?: number;
  }): Promise<void> {
    const { inputVideoPath, outputPath, words, subtitleStyle, width, height } = opts;

    if (!words || words.length === 0) {
      fs.copyFileSync(inputVideoPath, outputPath);
      return;
    }

    // 1. Generate ASS file
    const assContent = this.generateASS(words, subtitleStyle, width || 1080, height || 1920);
    const assPath = path.join(path.dirname(outputPath), `sub_${path.basename(outputPath, '.mp4')}.ass`);

    fs.writeFileSync(assPath, assContent, 'utf-8');

    // 2. Burn subtitles with FFmpeg
    try {
      const uploadDir = path.dirname(outputPath);
      const assFilename = path.basename(assPath);

      // Resolve fonts directory robustly
      let fontsDir = path.resolve(process.cwd(), 'assets', 'fonts');
      if (!fs.existsSync(fontsDir)) {
        fontsDir = path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts');
      }
      if (!fs.existsSync(fontsDir)) {
        fontsDir = path.resolve(__dirname, '..', '..', 'assets', 'fonts');
      }
      const hasFontsDir = fs.existsSync(fontsDir);

      // Use relative paths to avoid Windows drive letter escaping hell in filters
      // We will set cwd to uploadDir during exec
      const relativeFontsDir = path.relative(uploadDir, fontsDir).replace(/\\/g, '/');

      const assFilter = hasFontsDir
        ? `ass='${assFilename}':fontsdir='${relativeFontsDir}'`
        : `ass='${assFilename}'`;

      const useGpu = process.env.USE_GPU === 'true';

      const cmd = [
        `"${ffmpegPath}"`, '-y', '-loglevel', 'info',
        '-i', `"${path.basename(inputVideoPath)}"`,
        '-vf', `"${assFilter}"`,
        useGpu ? '-c:v h264_nvenc -preset p4 -cq 18' : '-vcodec libx264 -preset fast -crf 18',
        '-profile:v high', '-level', '4.1',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        `"${path.basename(outputPath)}"`,
      ].join(' ');

      this.logger.log(`Burning subtitles via FFmpeg. CWD: ${uploadDir}`);
      this.logger.log(`FFmpeg command: ${cmd}`);

      const runId = path.basename(outputPath, '.mp4');
      const startTime = Date.now();
      try {
        const { stderr } = await execAsync(cmd, {
          timeout: 420000,
          cwd: uploadDir
        });
        if (stderr && stderr.includes('fontselect:')) {
          const fontLogs = stderr
            .split(/[\r\n]+/)
            .filter((line) => line.includes('fontselect:'))
            .join('\n');
          this.logger.log(`Font selection log:\n${fontLogs}`);
        }
      } catch (err) {
        this.logger.error(`FFmpeg failed: ${err.message}`);
        if (err.stderr) {
          try {
            fs.writeFileSync(path.join(uploadDir, `error_${runId}.log`), err.stderr);
          } catch (e2) { }
        }
        throw err;
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`Subtitles burned in ${elapsed}s → ${outputPath}`);
    } finally {
      // try { if (fs.existsSync(assPath)) fs.unlinkSync(assPath); } catch {}
    }
  }

  /**
   * Gera conteúdo ASS completo.
   *
   * TIMING: Cada grupo de palavras aparece APENAS durante seu intervalo.
   * O grupo atual desaparece ANTES do próximo grupo aparecer, evitando sobreposição.
   */
  private generateASS(
    words: { text: string; start: number; end: number }[],
    style: Record<string, any>,
    width: number,
    height: number,
  ): string {
    // dados_legenda pode usar 'subtitle_preset' OU 'preset' dependendo de como foi salvo
    const preset = (style?.subtitle_preset || style?.preset || 'tiktok').toLowerCase();
    this.logger.log(`[ASS] Generating ASS. Preset: "${preset}" | Style keys: ${Object.keys(style || {}).filter(k => k !== 'words').join(', ')}`);
    this.logger.log(`[ASS] Style Details -> Font: ${style?.font_family}, Size: ${style?.font_size}, Color: ${style?.font_color}`);
    const maxWords = style?.max_words !== undefined ? Number(style.max_words) : 2;
    const fontFamily = style?.font_family;
    const rawFontSize = style?.font_size !== undefined ? Number(style.font_size) : 8;
    const fontSizePx = Math.round(rawFontSize * this.FONT_SCALE); // Scale up for video
    const posY = style?.posY !== undefined ? Number(style.posY) : 82;
    const fontColor = style?.font_color;
    const highlightColor = style?.highlight_color;
    const outlineColor = style?.outline_color;
    const outlineWidth = style?.outline_width !== undefined ? Number(style.outline_width) : undefined;
    const shadowDepth = style?.shadow_depth !== undefined ? Number(style.shadow_depth) : undefined;

    const playResX = width;
    const playResY = height;
    const marginV = Math.round(playResY * (1 - posY / 100));

    // Offset negativo para sincronizar a legenda com a voz.
    // Transcrições do AssemblyAI têm um atraso natural de ~50-100ms.
    const SYNC_OFFSET = -0.08;

    const presetStyles = this.getPresetASSStyles(preset, {
      fontFamily, fontSizePx, fontColor, highlightColor,
      outlineColor, outlineWidth, shadowDepth, marginV,
    });

    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${playResX}`,
      `PlayResY: ${playResY}`,
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      presetStyles.defaultStyle,
      presetStyles.activeStyle,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];

    // ── Build word groups ────────────────────────────────────────────────────
    const validWords = words.filter(w => w.text.trim().length > 0);

    // Apply sync offset to all word timestamps
    const syncedWords = validWords.map(w => ({
      ...w,
      start: Math.max(0, w.start + SYNC_OFFSET),
      end: Math.max(0, w.end + SYNC_OFFSET),
    }));

    const groups: { start: number; end: number; words: typeof syncedWords }[] = [];
    for (let i = 0; i < syncedWords.length; i += maxWords) {
      const group = syncedWords.slice(i, i + maxWords);
      groups.push({
        start: group[0].start,
        end: group[group.length - 1].end,
        words: group,
      });
    }

    // ── Fix timing: each group ends when the NEXT group starts ──────────────
    for (let i = 0; i < groups.length; i++) {
      const nextGroup = groups[i + 1];
      if (nextGroup) {
        groups[i].end = nextGroup.start;
      } else {
        groups[i].end = groups[i].end + 1.5;
      }
    }

    // ── Generate dialogue lines ─────────────────────────────────────────────
    const dialogueLines: string[] = [];

    for (const group of groups) {
      const groupStart = this.formatASSTime(group.start);
      const groupEnd = this.formatASSTime(group.end);

      if (maxWords === 1) {
        // ── Single word mode: one word at a time ──
        const word = group.words[0];
        dialogueLines.push(
          `Dialogue: 0,${groupStart},${groupEnd},Active,,0,0,0,,${this.applyPresetEffects(word.text.toUpperCase(), preset, true)}`
        );
      } else {
        // ── Multi-word mode: separate lines for each word's active period ──
        // Isso garante que as animações (como pop ou fade) reiniciem a cada palavra
        for (let wi = 0; wi < group.words.length; wi++) {
          const word = group.words[wi];
          const nextWord = group.words[wi + 1];

          const partStart = this.formatASSTime(Math.max(group.start, word.start));
          const partEnd = this.formatASSTime(nextWord ? nextWord.start : group.end);

          const textParts = group.words.map((w, idx) => {
            if (idx === wi) {
              // Palavra ativa com efeito e reset de estilo
              return `{\\rActive}${this.applyPresetEffects(w.text.toUpperCase(), preset, true)}{\\rDefault}`;
            }
            // Palavra inativa
            return this.applyPresetEffects(w.text.toUpperCase(), preset, false);
          }).join(' ');

          dialogueLines.push(`Dialogue: 0,${partStart},${partEnd},Default,,0,0,0,,${textParts}`);
        }
      }
    }

    return [...header, ...dialogueLines].join('\n');
  }

  /**
   * Retorna estilos ASS para cada preset.
   */
  private getPresetASSStyles(preset: string, cfg: {
    fontFamily?: string; fontSizePx: number; fontColor?: string; highlightColor?: string;
    outlineColor?: string; outlineWidth?: number; shadowDepth?: number; marginV: number;
  }): { defaultStyle: string; activeStyle: string } {
    const { fontFamily, fontSizePx, fontColor, highlightColor, outlineColor, outlineWidth, shadowDepth, marginV } = cfg;

    const toASSColor = (hex: string, alpha = 0): string => {
      // Tratar "transparent" → totalmente transparente no ASS (FF = invisível)
      if (!hex || hex === 'transparent') return '&HFF000000';

      // Tratar rgba(r, g, b, a) ou rgb(r, g, b)
      const rgbaMatch = hex.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (rgbaMatch) {
        const r = parseInt(rgbaMatch[1]).toString(16).padStart(2, '0');
        const g = parseInt(rgbaMatch[2]).toString(16).padStart(2, '0');
        const b = parseInt(rgbaMatch[3]).toString(16).padStart(2, '0');
        // Em ASS, alpha é invertido: 0x00 = opaco, 0xFF = invisível
        const cssAlpha = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
        const assAlpha = Math.round((1 - cssAlpha) * 255).toString(16).padStart(2, '0').toUpperCase();
        return `&H${assAlpha}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
      }

      // Lógica hex padrão
      hex = hex.replace(/^#/, '').replace(/[^0-9a-fA-F]/g, '');
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      if (hex.length < 6) hex = 'FFFFFF';
      const r = hex.substring(0, 2);
      const g = hex.substring(2, 4);
      const b = hex.substring(4, 6);
      const a = alpha.toString(16).padStart(2, '0').toUpperCase();
      return `&H${a}${b}${g}${r}`.toUpperCase();
    };

    const alignment = 2;
    const bold = -1;
    const scaleX = 100;
    const scaleY = 100;

    const presetConfigs: Record<string, {
      defaultFont?: string; defaultColor: string; activeColor: string;
      outline: string; outlineW: number; shadow: number;
      backColor?: string; borderStyle?: number; spacing?: number;
    }> = {
      // ── Originais ──────────────────────────────────────────────────────
      tiktok: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFF00', activeColor: '#FFFF00',
        outline: '#000000', outlineW: outlineWidth || 4, shadow: 0,
      },
      highlight: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#F7C204',
        outline: '#000000', outlineW: 0, shadow: 2,
        backColor: '#000000',
      },
      karaoke: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#00FF00',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      capcut: {
        defaultFont: 'Montserrat',
        defaultColor: '#000000', activeColor: '#000000',
        outline: '#000000', outlineW: 0, shadow: 0,
        backColor: '#FFE500', borderStyle: 3,
      },
      instagram: {
        defaultFont: 'Montserrat',
        defaultColor: '#DD2A7B', activeColor: '#F58529',
        outline: '#000000', outlineW: 0, shadow: 1,
      },
      cinematic: {
        defaultFont: 'Staatliches',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
        backColor: '#000000', borderStyle: 3,
      },
      impact: {
        defaultFont: 'Montserrat',
        defaultColor: '#FF3B3B', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: outlineWidth || 3, shadow: 2,
      },
      // ── Clássicos ──────────────────────────────────────────────────────
      neon: {
        defaultFont: 'Monoton',
        defaultColor: '#FFFFFF', activeColor: '#FF00FF',
        outline: '#00FFFF', outlineW: 1, shadow: 3,
      },
      matrix: {
        defaultFont: 'Press Start 2P',
        defaultColor: '#00FF00', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
        backColor: '#00FF00', borderStyle: 3,
      },
      pop3d: {
        defaultFont: 'Black Ops One',
        defaultColor: '#FFAA00', activeColor: '#FFFFFF',
        outline: '#FF5500', outlineW: 1, shadow: 5,
      },
      liquid: {
        defaultFont: 'Ultra',
        defaultColor: '#CCCCCC', activeColor: '#FFFFFF',
        outline: '#B4B4FF', outlineW: 1.5, shadow: 1,
      },
      explosive: {
        defaultFont: 'Bangers',
        defaultColor: '#FF4400', activeColor: '#FFCC00',
        outline: '#FFCC00', outlineW: 2, shadow: 3,
      },
      neonglow: {
        defaultFont: 'Monoton',
        defaultColor: '#00FF88', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 3,
      },
      glitch: {
        defaultFont: 'Bangers',
        defaultColor: '#FFFFFF', activeColor: '#FF00FF',
        outline: '#FF00FF', outlineW: 2, shadow: 0,
      },
      fire: {
        defaultFont: 'Anton',
        defaultColor: '#FFAA00', activeColor: '#FFFFFF',
        outline: '#FF6600', outlineW: 2, shadow: 2,
      },
      water: {
        defaultFont: 'Pacifico',
        defaultColor: '#00FFFF', activeColor: '#FFFFFF',
        outline: '#00AAFF', outlineW: 1.5, shadow: 0,
      },
      rainbow: {
        defaultFont: 'Bungee',
        defaultColor: '#FF6060', activeColor: '#FFFFFF',
        outline: '#60FF60', outlineW: 1.5, shadow: 0,
      },
      shadow: {
        defaultFont: 'Alfa Slab One',
        defaultColor: '#FFAA00', activeColor: '#FFFFFF',
        outline: '#6464FF', outlineW: 1, shadow: 5,
      },
      pixel: {
        defaultFont: 'Press Start 2P',
        defaultColor: '#FFFF00', activeColor: '#FFFFFF',
        outline: '#FFFF00', outlineW: 1.5, shadow: 0,
      },
      retro: {
        defaultFont: 'Lobster',
        defaultColor: '#FF88CC', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 2,
      },
      gradientorig: {
        defaultFont: 'Orbitron',
        defaultColor: '#00FFFF', activeColor: '#FFFFFF',
        outline: '#FF00FF', outlineW: 1.5, shadow: 1,
      },
      gradient: {
        defaultFont: 'Orbitron',
        defaultColor: '#00FFFF', activeColor: '#FFFFFF',
        outline: '#FF00FF', outlineW: 1.5, shadow: 1,
      },
      gradientcup: {
        defaultFont: 'Fredoka One',
        defaultColor: '#FF00AA', activeColor: '#FFFFFF',
        outline: '#00AAFF', outlineW: 1.5, shadow: 0,
      },
      outline: {
        defaultFont: 'Anton',
        defaultColor: '#FFFFFF', activeColor: '#FFFC00',
        outline: '#FFFC00', outlineW: 3, shadow: 0,
      },
      chrome: {
        defaultFont: 'Black Ops One',
        defaultColor: '#CCCCCC', activeColor: '#FFFFFF',
        outline: '#FFFFFF', outlineW: 1, shadow: 2,
      },
      glass: {
        defaultFont: 'Righteous',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#FFFFFF', outlineW: 1.2, shadow: 0,
      },
      // ── Novos 2025 ─────────────────────────────────────────────────────
      bouncycolor: {
        defaultFont: 'Montserrat',
        defaultColor: fontColor || '#FFFFFF', activeColor: highlightColor || '#FFE500',
        outline: outlineColor || '#000000', outlineW: outlineWidth || 2, shadow: shadowDepth || 3,
      },
      wordbyword: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFE500',
        outline: '#000000', outlineW: 2, shadow: 2,
      },
      highlightbox: {
        defaultFont: 'Montserrat',
        defaultColor: '#000000', activeColor: '#000000',
        outline: '#000000', outlineW: 0, shadow: 0,
        backColor: '#FF6B6B', borderStyle: 3,
      },
      splitflap: {
        defaultFont: 'Courier New',
        defaultColor: '#FFE500', activeColor: '#FFE500',
        outline: '#FFE500', outlineW: 2, shadow: 0,
        backColor: '#111111', borderStyle: 3,
      },
      scramble: {
        defaultFont: 'Courier New',
        defaultColor: '#FFFFFF', activeColor: '#00FFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      firetext: {
        defaultFont: 'Impact',
        defaultColor: '#FFAA00', activeColor: '#FFFFFF',
        outline: '#FF4500', outlineW: 1, shadow: 2,
      },
      rainbowwave: {
        defaultFont: 'Montserrat',
        defaultColor: '#FF6060', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      threed: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#888888', outlineW: 0, shadow: 8,
      },
      bubble: {
        defaultFont: 'Montserrat',
        defaultColor: '#111111', activeColor: '#111111',
        outline: '#000000', outlineW: 0, shadow: 2,
        backColor: '#FFFFFF', borderStyle: 3,
      },
      countdown: {
        defaultFont: 'Impact',
        defaultColor: '#FFFFFF', activeColor: '#FF6B6B',
        outline: '#FF6B6B', outlineW: 1, shadow: 0,
      },
      slideinleft: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 2, shadow: 2,
      },
      stamp: {
        defaultFont: 'Impact',
        defaultColor: '#FF3B3B', activeColor: '#FF3B3B',
        outline: '#FF3B3B', outlineW: 3, shadow: 0,
      },
      holographic: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FF88FF',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      gradshift: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#C084FC',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      shadowdepth: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#6464FF', outlineW: 0, shadow: 4,
      },
      zoombeat: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 2, shadow: 0,
      },
      outlineflash: {
        defaultFont: 'Impact',
        defaultColor: '#FFE500', activeColor: '#FFE500',
        outline: '#FFE500', outlineW: 3, shadow: 0,
      },
      sticker: {
        defaultFont: 'Montserrat',
        defaultColor: '#000000', activeColor: '#000000',
        outline: '#000000', outlineW: 3, shadow: 1,
        backColor: '#FFE500', borderStyle: 3,
      },
      morph: {
        defaultFont: 'Montserrat',
        defaultColor: '#4ECDC4', activeColor: '#A855F7',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      stackreveal: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 1, shadow: 2,
      },
      liquidflow: {
        defaultFont: 'Montserrat',
        defaultColor: '#4ECDC4', activeColor: '#44CF6C',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      pixelreveal: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 1, shadow: 0,
      },
      cassette: {
        defaultFont: 'Courier New',
        defaultColor: '#2D2D2D', activeColor: '#E63946',
        outline: '#2D2D2D', outlineW: 2, shadow: 0,
        backColor: '#F5F0E8', borderStyle: 3,
      },
      bouncywords: {
        defaultFont: 'Montserrat',
        defaultColor: '#FF6B6B', activeColor: '#FFE66D',
        outline: '#000000', outlineW: 2, shadow: 3,
      },
      terminal: {
        defaultFont: 'Courier New',
        defaultColor: '#FFFFFF', activeColor: '#27C93F',
        outline: '#000000', outlineW: 0, shadow: 0,
        backColor: '#1E1E1E', borderStyle: 3,
      },
      slicereveal: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      chalkboard: {
        defaultFont: 'Patrick Hand',
        defaultColor: '#F0ECD8', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
        backColor: '#2D5A3D', borderStyle: 3,
      },
      punchtext: {
        defaultFont: 'Impact',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 3, shadow: 4,
      },
      newsticker: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
        backColor: '#E63946', borderStyle: 3,
      },
      particles: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFE500',
        outline: '#000000', outlineW: 1, shadow: 0,
      },
      noise: {
        defaultFont: 'Montserrat',
        defaultColor: '#FFFFFF', activeColor: '#FFFFFF',
        outline: '#000000', outlineW: 0, shadow: 0,
      },
      strokepop: {
        defaultFont: 'Bangers',
        defaultColor: '#111111', activeColor: '#FFFFFF',
        outline: '#FFFFFF', outlineW: 4, shadow: 0,
      },
    };

    const pc = presetConfigs[preset] || {
      defaultColor: '#FFFFFF', activeColor: '#FFE500',
      outline: '#000000', outlineW: 2, shadow: 0,
    };

    // Prioridade da escolha do usuário (cores/espessura vindas do app) em relação ao preset fixo
    const finalFont = fontFamily || pc.defaultFont || 'Montserrat';
    const finalDefaultColor = fontColor || pc.defaultColor || '#FFFFFF';
    const finalActiveColor = highlightColor || pc.activeColor || '#FFE500';
    const finalOutlineColor = outlineColor || pc.outline || '#000000';
    const finalOutlineW = outlineWidth ?? pc.outlineW ?? 2;
    const finalShadowDepth = shadowDepth ?? pc.shadow ?? 0;

    this.logger.log(`[ASS] Preset Mapping: "${preset}" -> Font: "${finalFont}", Colors: ${finalDefaultColor}/${finalActiveColor}`);
    const bStyle = pc.borderStyle || 1;
    const spacing = pc.spacing || 0;

    const makeStyle = (name: string, color: string) => {
      const back = pc.backColor || '000000';
      return `Style: ${name},${finalFont},${fontSizePx},${toASSColor(color)},${toASSColor(color)},${toASSColor(finalOutlineColor)},${toASSColor(back, bStyle === 3 ? 0 : 128)},${bold},0,0,0,${scaleX},${scaleY},${spacing},0,${bStyle},${finalOutlineW},${finalShadowDepth},${alignment},40,40,${marginV},1`;
    };

    return {
      defaultStyle: makeStyle('Default', finalDefaultColor),
      activeStyle: makeStyle('Active', finalActiveColor),
    };
  }

  /**
   * Aplica efeitos ASS inline para presets específicos.
   */
  private applyPresetEffects(text: string, preset: string, isActive: boolean): string {
    if (!isActive) return text;

    // ── Referência de tags ASS inline usadas aqui ─────────────────────────────
    // \fscx / \fscy  → escala horizontal/vertical (%)
    // \t(t0,t1,tags) → anima tags de t0ms a t1ms
    // \fad(in,out)   → fade in/out em ms
    // \move(x1,y1,x2,y2[,t0,t1]) → move de (x1,y1) a (x2,y2)
    // \blur N        → desfoque gaussiano
    // \frz N         → rotação em graus (eixo Z)
    // \fsp N         → espaçamento entre letras (px)
    // \alpha &HXX&   → transparência (00=opaco, FF=invisível)
    // ─────────────────────────────────────────────────────────────────────────

    switch (preset) {

      // ── Pop / Bounce (escala 120%) ─────────────────────────────────────────
      case 'highlight':
      case 'bouncycolor':
      case 'wordbyword':
      case 'bouncywords':
      case 'instagram':
      case 'highlightbox':
      case 'morph':
      case 'liquidflow':
      case 'gradientcup':
        return `{\\fscx120\\fscy120\\t(0,150,\\fscx100\\fscy100)}${text}`;

      // ── Soco / Punch (escala 140%) ─────────────────────────────────────────
      case 'countdown':
      case 'zoombeat':
      case 'punchtext':
      case 'strokepop':
      case 'impact':
      case 'explosive':
      case 'pop3d':
      case 'firetext':
      case 'fire':
        return `{\\fscx140\\fscy140\\t(0,200,\\fscx100\\fscy100)}${text}`;

      // ── Stamp (escala 160%, decay lento) ─────────────────────────────────
      case 'stamp':
        return `{\\fscx160\\fscy160\\t(0,300,\\fscx100\\fscy100)}${text}`;

      // ── Sticker / CapCut (escala leve 115%) ───────────────────────────────
      case 'sticker':
      case 'capcut':
      case 'bubble':
      case 'cassette':
      case 'terminal':
      case 'newsticker':
      case 'splitflap':
        return `{\\fscx115\\fscy115\\t(0,200,\\fscx100\\fscy100)}${text}`;

      // ── Fade in + Pop suave (110%) ─────────────────────────────────────────
      case 'pixelreveal':
      case 'stackreveal':
      case 'noise':
      case 'glitch':
      case 'neonglow':
      case 'rainbow':
      case 'rainbowwave':
      case 'holographic':
      case 'gradshift':
      case 'outline':
      case 'chrome':
      case 'particles':
        return `{\\fad(80,0)\\fscx110\\fscy110\\t(0,180,\\fscx100\\fscy100)}${text}`;

      case 'neon':
        // Glitch neon: Brilho (\blur) pulsante e distorsão (\fax) rápida para tremor (glitch)
        return `{\\fad(60,0)\\blur6\\fscx110\\fscy110\\t(0,120,\\fscx100\\fscy100)\\t(0,80,\\fax-0.08)\\t(80,160,\\fax0.12\\blur10)\\t(160,240,\\fax-0.05\\blur3)}${text}`;

      // ── Fade in puro (sem escala) ──────────────────────────────────────────
      case 'shadow':
      case 'shadowdepth':
      case 'threed':
      case 'glass':
      case 'retro':
      case 'slicereveal':
      case 'scramble':
        return `{\\fad(100,0)}${text}`;

      // ── Fade in + escala gradiente/liquid ─────────────────────────────────
      case 'gradient':
      case 'gradientorig':
      case 'liquid':
      case 'water':
      case 'pixel':
        return `{\\fad(60,0)\\fscx105\\fscy105\\t(0,200,\\fscx100\\fscy100)}${text}`;

      // ── Slide da esquerda ──────────────────────────────────────────────────
      case 'slideinleft':
        return `{\\move(-200,0,0,0,0,200)}${text}`;

      // ── OutlineFlash: fade in rápido + escala ─────────────────────────────
      case 'outlineflash':
        return `{\\fad(50,0)\\fscx130\\fscy130\\t(0,150,\\fscx100\\fscy100)}${text}`;

      // ── Fade in suave (presets cuja animação CSS é apenas cor/opacity) ─────
      case 'matrix':
      case 'chalkboard':
        return `{\\fad(100,0)}${text}`;

      case 'cinematic':
        return `{\\fad(150,50)}${text}`;

      // ── Puramente estáticos — só troca de cor Default↔Active ──────────────
      case 'tiktok':
      case 'karaoke':
        return text;

      default:
        // Fade in mínimo para qualquer preset sem animação explícita
        return `{\\fad(80,0)}${text}`;
    }
  }

  /**
   * Formata tempo em formato ASS: H:MM:SS.CC
   */
  private formatASSTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
  }
}
