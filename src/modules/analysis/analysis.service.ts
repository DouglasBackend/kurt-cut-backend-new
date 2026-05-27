import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Groq from "groq-sdk";
import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

@Injectable()
export class AnalysisService {
  private groq: Groq;
  private gemini: GoogleGenerativeAI;
  private geminiModel: GenerativeModel;
  private readonly logger = new Logger(AnalysisService.name);

  constructor(private readonly configService: ConfigService) {
    this.groq = new Groq({
      apiKey: this.configService.get<string>("GROQ_API_KEY", ""),
    });
    this.gemini = new GoogleGenerativeAI(this.configService.get<string>("GEMINI_API_KEY", ""));
    this.geminiModel = this.gemini.getGenerativeModel({ model: "gemini-2.5-flash" });
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 2000): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isRateLimit = error.message?.includes('429') || error.status === 429;
        const isLastAttempt = attempt === maxAttempts;
        if (!isRateLimit || isLastAttempt) throw error;
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        this.logger.warn(`Groq rate limit, attempt ${attempt}/${maxAttempts}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Max retry attempts reached');
  }

  private refineClipBoundaries(clip: any, words: any[], audioFeatures?: any, targetDuration?: number): { start_time: number, end_time: number } {
    let start = parseFloat(clip.start_time);
    let end = parseFloat(clip.end_time);

    if (words && words.length > 0) {
      // 1. Snap to words
      const findClosestWord = (timeMs: number) => {
        return words.reduce((prev, curr) =>
          Math.abs(curr.start - timeMs) < Math.abs(prev.start - timeMs) ? curr : prev
        );
      };

      const startWord = findClosestWord(start * 1000);
      let endWord = findClosestWord(end * 1000);

      start = startWord.start / 1000;
      end = endWord.end / 1000;

      // 1.1 Speech-aware greedy end (ensure we don't cut in the middle of a sentence)
      // If we have a targetDuration, we allow a bit of "greediness" (up to 5s extra) 
      // to find a natural ending (punctuation or silence).
      const MAX_GREEDY_MS = 5000;
      const startIndex = words.indexOf(endWord);

      if (startIndex !== -1) {
        let bestEnd = endWord.end;
        let foundNaturalEnd = false;

        // Check the next few words for a natural pause or punctuation
        for (let i = startIndex; i < words.length && (words[i].end - endWord.end) < MAX_GREEDY_MS; i++) {
          const w = words[i];
          const text = (w.text || "").trim();

          // Check for punctuation at the end of the word
          if (text.endsWith('.') || text.endsWith('!') || text.endsWith('?') || text.endsWith(';')) {
            bestEnd = w.end;
            foundNaturalEnd = true;
            break;
          }

          // Check for a significant silence after this word (e.g. > 400ms)
          if (i < words.length - 1) {
            const nextW = words[i + 1];
            if (nextW.start - w.end > 400) {
              bestEnd = w.end;
              foundNaturalEnd = true;
              break;
            }
          }
        }

        if (foundNaturalEnd) {
          end = bestEnd / 1000;
        }
      }
    }

    // 2. Adjust end time for silence (fine-tuning)
    if (audioFeatures?.silence_segments) {
      const silences = audioFeatures.silence_segments;
      // If there's a silence very close to the end (within 1.5s), snap to it
      const nearbySilence = silences.find((s: any) =>
        s.start >= end - 0.5 && s.start <= end + 1.5
      );

      if (nearbySilence) {
        end = nearbySilence.start;
      }
    }

    return { start_time: start, end_time: end };
  }

  async analyzeTranscript(
    transcriptText: string,
    words: any[],
    videoTitle: string,
    duration: number,
    audioFeatures?: any,
    minClipsOverride?: number,
    maxClipsOverride?: number,
    targetDuration?: number,
  ): Promise<any> {
    const minClips = minClipsOverride || 3;
    const maxClips = maxClipsOverride || 5;
    const wordTimeline = this.buildWordTimeline(words);
    const audioContext = this.buildAudioContext(audioFeatures);

    const prompt = this.buildPrompt(videoTitle, duration, audioContext, wordTimeline, transcriptText, minClips, maxClips, targetDuration);

    // 1. Tentar Gemini como fonte principal
    try {
      this.logger.log(`Tentando análise com Gemini... (TargetDuration: ${targetDuration ?? 'padrão'})`);
      const result = await this.geminiModel.generateContent(prompt);
      const response = result.response;
      let text = response.text();

      // Limpeza de markdown se necessário
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();

      const parsed = JSON.parse(text);

      // Pass source data for refinement
      parsed.words_source = words;
      parsed.audio_features_source = audioFeatures;
      parsed.target_duration_source = targetDuration;

      return this.processAnalysisResult(parsed, duration);
    } catch (geminiError) {
      this.logger.warn(`Gemini falhou: ${geminiError.message}. Tentando Groq como fallback...`);

      // 2. Fallback para Groq
      try {
        const chatCompletion = await this.withRetry(() =>
          this.groq.chat.completions.create({
            messages: [
              { role: "system", content: "Você é um analista de vídeos virais que responde apenas em JSON puro." },
              { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" }
          })
        );

        const response = chatCompletion.choices[0]?.message?.content;
        if (!response) throw new Error("Empty response from Groq");

        const parsed = JSON.parse(response);

        parsed.words_source = words;
        parsed.audio_features_source = audioFeatures;
        parsed.target_duration_source = targetDuration;

        return this.processAnalysisResult(parsed, duration);
      } catch (groqError) {
        this.logger.error(`Groq fallback também falhou: ${groqError.message}`);
        return {
          summary: "Análise não disponível",
          topics: [],
          clips: this.generateBasicClips(duration),
          best_clip_index: 0,
          viral_potential: "médio",
        };
      }
    }
  }

  private buildAudioContext(audioFeatures?: any): string {
    if (!audioFeatures) return "";
    return `
âââ ANÁLISE DE ÁUDIO (FFmpeg) âââ
Picos de energia detectados (momentos de destaque, já ordenados por intensidade):
${audioFeatures.energy_peaks?.slice(0, 8).map((p: any) =>
      `  ${(p.timestamp || 0).toFixed(1)}s â ${(p.energy || 0).toFixed(1)}dB`).join("\n") || "  nenhum detectado"}

Segmentos de silêncio (pausas naturais â bons pontos de corte):
${audioFeatures.silence_segments?.slice(0, 8).map((s: any) =>
        `  ${(s.start || 0).toFixed(1)}s â ${(s.end || 0).toFixed(1)}s (${((s.end || 0) - (s.start || 0)).toFixed(1)}s)`).join("\n") || "  nenhum detectado"}

Energia média: ${audioFeatures.average_energy?.toFixed(1) ?? "N/A"} dB
Range dinâmico: ${audioFeatures.dynamic_range?.toFixed(1) ?? "N/A"} dB
âââ USE: prefira clips que iniciam APÓS um pico de energia e terminam em silêncio âââ
`;
  }

  private buildPrompt(videoTitle: string, duration: number, audioContext: string, wordTimeline: string, transcriptText: string, minClips: number, maxClips: number, targetDuration?: number): string {
    const durationRule = targetDuration
      ? `Duração ALVO: Cada clip deve ter aproximadamente ${targetDuration} segundos. Tente não variar mais que 10% para baixo, mas pode exceder alguns segundos para não cortar falas.`
      : `Duração IDEAL: Cada clip deve ter entre 30 e 90 segundos. Se o vídeo for curto (menos de 60s), clips de 15s são aceitáveis, mas priorize 30s+.`;

    return `
Você é um especialista em criação de conteúdo viral (YouTube Shorts, TikTok, Instagram Reels) e narrativa cinematográfica.
Sua missão é extrair clipes que contem uma "micro-história" completa.

Identifique até ${maxClips} momentos virais. Priorize o contexto e a fluidez sobre a brevidade extrema.
RECOMENDAÇÃO: Um clipe de 30 segundos com um gancho forte é MUITO melhor que um clipe de 5 segundos contendo APENAS o gancho.

Título: "${videoTitle}"
Duração Total: ${(duration || 0).toFixed(0)}s (${Math.floor((duration || 0) / 60)}min ${Math.floor((duration || 0) % 60)}s)
${audioContext}

âââ TRANSCRIÇÃO COM TIMESTAMPS (formato: [segundos] palavra) âââ
${wordTimeline}
âââ FIM âââ

TEXTO COMPLETO PARA CONTEXTO:
${transcriptText.slice(0, 2000)}

REGRAS OBRIGATÓRIAS:
1. Retorne entre ${minClips} e ${maxClips} clips virais. Tente sempre chegar ao limite de ${maxClips} se o conteúdo permitir.
2. ${durationRule}
3. ZERO sobreposição de timestamps entre clips.
4. start_time e end_time DEVEM corresponder a palavras REAIS.
5. REGRA DE OURO: Clipes com menos de 30 SEGUNDOS são ESTRITAMENTE PROIBIDOS, exceto se o vídeo total tiver menos de 45 segundos. Se o gancho for curto, inclua o que vem antes E o que vem depois para chegar em 30-60 segundos obrigatoriamente.
6. Procure terminar o clipe em um momento de silêncio ou conclusão de raciocínio.
7. Priorize: revelação, humor, emoção, insight e conflito.
8. O gancho (hook) deve estar nos primeiros 3-5 segundos do clipe. Inclua MUITO CONTEÚDO DEPOIS do gancho para manter a retenção e chegar aos 30-45s.
9. IGNORE a introdução do vídeo (cumprimentos iniciais, de onde viemos, etc). Não extraia cortes do início a menos que a pura ação já comece lá.
10. Cortes não podem conter conversas fúteis de "se inscreva no canal". Vá direto para o que importa.
11. Se o vídeo tiver transições de áudio ou picos de energia (dB altos), estes são geralmente excelentes pontos para ganchos.

Retorne JSON puro sem markdown seguindo este esquema:
{
  "summary": "Resumo do conteúdo em 2-3 frases",
  "topics": ["tópico1", "tópico2", "tópico3"],
  "language": "pt-BR",
  "viral_potential": "alto",
  "clips": [
    {
      "title": "Título chamativo do clip (máx 60 chars)",
      "start_time": 12.4,
      "end_time": 67.8,
      "clip_type": "short",
      "score": 9.5,
      "reason": "Por que este momento é viral (1-2 frases)",
      "hook": "Frase exata do gancho inicial",
      "aspect_ratio": "9:16",
      "energy_level": "high",
      "emotion": "surprise"
    }
  ],
  "best_clip_index": 0
}`;
  }

  private processAnalysisResult(parsed: any, duration: number): any {
    if (parsed.clips && Array.isArray(parsed.clips)) {
      const targetDuration = parsed.target_duration_source;

      parsed.clips = parsed.clips
        .map((clip: any) => {
          const refined = this.refineClipBoundaries(clip, parsed.words_source || [], parsed.audio_features_source, targetDuration);
          let start = Math.max(0, refined.start_time || 0);
          let end = Math.min(duration, refined.end_time || duration);

          // EXPANSÃO FORÇADA: Se o clipe for menor que 30s, expandimos para garantir qualidade
          const currentDur = end - start;
          const minRequired = 30;
          if (currentDur < minRequired) {
            const needed = minRequired - currentDur;
            // Tenta tirar 30% do 'needed' do início e 70% do final para manter o hook no começo
            start = Math.max(0, start - (needed * 0.3));
            end = Math.min(duration, end + (needed * 0.7));

            // Re-check se ainda é curto após expansão (pode ter batido nos limites do vídeo)
            const newDur = end - start;
            if (newDur < minRequired && duration >= minRequired) {
              // Se ainda é curto e o vídeo permite mais, tenta expandir para o lado que sobrou
              if (start === 0) end = Math.min(duration, minRequired);
              else if (end === duration) start = Math.max(0, duration - minRequired);
            }
          }

          return {
            ...clip,
            start_time: start,
            end_time: end,
          };
        })
        .filter((clip: any) => {
          const dur = clip.end_time - clip.start_time;
          return dur >= 2; // Mantemos o limite de 2s para segurança, mas o prompt pede mais.
        });

      parsed.clips = this.removeOverlaps(parsed.clips);
    }

    this.logger.log(`Analysis complete: ${parsed.clips?.length ?? 0} clips, potential=${parsed.viral_potential}`);
    return parsed;
  }

  private removeOverlaps(clips: any[]): any[] {
    // Calculamos um score ponderado que favorece durações entre 20-60 segundos
    const getWeightedScore = (c: any) => {
      const duration = (c.end_time || 0) - (c.start_time || 0);
      let multiplier = 1.0;

      if (duration < 20) multiplier = 0.5; // Penaliza muito curto
      else if (duration < 30) multiplier = 0.7;
      else if (duration >= 30 && duration <= 65) multiplier = 1.4; // Bônus para "sweet spot"
      else if (duration > 120) multiplier = 0.8; // Leve penalidade para muito longo

      return (c.score || 0) * multiplier;
    };

    const sorted = [...clips].sort((a, b) => getWeightedScore(b) - getWeightedScore(a));
    const accepted: any[] = [];
    for (const clip of sorted) {
      const overlaps = accepted.some(
        (a) => clip.start_time < a.end_time && clip.end_time > a.start_time,
      );
      if (!overlaps) accepted.push(clip);
    }
    return accepted;
  }

  private buildWordTimeline(words: any[]): string {
    if (!words || words.length === 0) return "(timestamps não disponíveis)";
    const lines: string[] = [];
    let line: string[] = [];

    for (const w of words) {
      const startSec = ((w.start || 0) / 1000).toFixed(2);
      line.push(`[${startSec}s] ${w.text}`);
      if (line.length >= 12) {
        lines.push(line.join("  "));
        line = [];
      }
    }
    if (line.length > 0) lines.push(line.join("  "));

    // Limit to 100 lines for Groq/Gemini to stay safe with token limits
    const maxLines = 100;
    if (lines.length > maxLines) {
      const half = Math.floor(maxLines / 2);
      return [
        ...lines.slice(0, half),
        `... (${lines.length - maxLines} linhas omitidas do meio) ...`,
        ...lines.slice(lines.length - half),
      ].join("\n");
    }
    return lines.join("\n");
  }

  private generateBasicClips(duration: number): any[] {
    // Para vídeos curtos (<60s), use o vídeo inteiro como um único clip
    const clipDuration = duration < 60 ? duration : 60;
    const maxClips = Math.max(1, Math.min(3, Math.floor(duration / Math.max(1, clipDuration))));
    return Array.from({ length: maxClips }, (_, i) => ({
      title: `Clip ${i + 1}`,
      start_time: i * clipDuration,
      end_time: Math.min((i + 1) * clipDuration, duration),
      clip_type: "short",
      score: 7,
      reason: "Clip gerado automaticamente",
      hook: "Início do clip",
      aspect_ratio: "9:16",
      energy_level: "medium",
      emotion: "education",
    }));
  }
}
