import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AssemblyAI } from "assemblyai";

@Injectable()
export class TranscriptionService {
  private client: AssemblyAI;
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(private readonly configService: ConfigService) {
    this.client = new AssemblyAI({ apiKey: this.configService.get<string>("ASSEMBLYAI_API_KEY", "") });
  }

  async transcribe(filePath: string): Promise<{
    id: string;
    text: string;
    words: any[];
    sentences: any[];
  }> {
    const langCode = this.configService.get<string>("TRANSCRIPTION_LANGUAGE", "");

    try {
      const transcriptParams: any = {
        audio: filePath,
        punctuate: false,
        format_text: false,
        // Word-level timestamps — critical for accurate clip cutting and ASS subtitles
        word_boost: [],
        speech_models: ["universal-3-pro", "universal-2"],
      };

      // Se o .env não tiver, força para Português (pt) porque o auto-detect erra muito em português.
      if (langCode) {
        transcriptParams.language_code = langCode;
      } else {
        transcriptParams.language_code = "pt";
      }

      this.logger.log(
        `Transcribing with model=best, lang=${langCode || "auto-detect"}`,
      );
      const transcript =
        await this.client.transcripts.transcribe(transcriptParams);

      if (transcript.status === "error") {
        throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
      }

      this.logger.log(
        `Transcription complete: ${transcript.words?.length ?? 0} words, lang=${transcript.language_code}`,
      );

      // Clean punctuation from words as requested: "apenas o texto puro mesmo"
      const cleanWords = (transcript.words || []).map((w: any) => ({
        ...w,
        text: w.text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").trim()
      }));

      return {
        id: transcript.id,
        text: cleanWords.map(w => w.text).join(" "),
        words: cleanWords,
        sentences: [],
      };
    } catch (error) {
      this.logger.error(`Transcription error: ${error.message}`);
      throw error;
    }
  }

  async getSubtitlesSRT(
    transcriptId: string,
    charsPerCaption = 40,
  ): Promise<string> {
    return this.client.transcripts.subtitles(
      transcriptId,
      "srt",
      charsPerCaption,
    );
  }

  async getSubtitlesVTT(
    transcriptId: string,
    charsPerCaption = 40,
  ): Promise<string> {
    return this.client.transcripts.subtitles(
      transcriptId,
      "vtt",
      charsPerCaption,
    );
  }

  async getStatus(transcriptId: string): Promise<any> {
    return this.client.transcripts.get(transcriptId);
  }
}
