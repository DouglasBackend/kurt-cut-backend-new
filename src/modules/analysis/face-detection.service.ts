import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { StorageService } from '../../common/storage/storage.service';

const execAsync = promisify(exec);
const ffmpegPath = require('ffmpeg-static');

@Injectable()
export class FaceDetectionService {
  private gemini: GoogleGenerativeAI;
  private geminiModel: GenerativeModel;
  private readonly logger = new Logger(FaceDetectionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.gemini = new GoogleGenerativeAI(this.configService.get<string>('GEMINI_API_KEY', ''));
    this.geminiModel = this.gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  /**
   * Detects the main face in a video segment using Gemini Vision.
   * Returns normalized coordinates [xCenter, yCenter] (0.0 to 1.0).
   */
  async detectMainFacePosition(
    videoPath: string,
    startTime: number,
    duration: number,
  ): Promise<{ xCenter: number; yCenter: number }> {
    const uploadDir = this.storageService.getAbsoluteUploadDir();
    const tempPrefix = `face_detect_${Date.now()}`;
    const framePaths: string[] = [];

    try {
      // 1. Extract 3 frames (start, middle, end of clip)
      const safeDuration = Math.max(1, duration);
      const timestamps = [
        startTime + safeDuration * 0.1,
        startTime + safeDuration * 0.5,
        startTime + safeDuration * 0.9,
      ];

      for (let i = 0; i < timestamps.length; i++) {
        const framePath = path.join(uploadDir, `${tempPrefix}_frame_${i}.jpg`);
        try {
          await execAsync(`"${ffmpegPath}" -ss ${timestamps[i]} -i "${videoPath}" -vframes 1 -q:v 2 -y "${framePath}"`);
          if (fs.existsSync(framePath)) {
            framePaths.push(framePath);
          }
        } catch (e) {
          this.logger.warn(`Frame extraction failed at ${timestamps[i]}s: ${e.message}`);
        }
      }

      if (framePaths.length === 0) {
        this.logger.warn('Could not extract any frames for face detection');
        return { xCenter: 0.5, yCenter: 0.35 };
      }

      // 2. Prepare images for Gemini
      const imageParts = framePaths.map(p => ({
        inlineData: {
          data: fs.readFileSync(p).toString('base64'),
          mimeType: 'image/jpeg',
        },
      }));

      // 3. Prompt Gemini to find the main face
      const prompt = `Analise estas ${framePaths.length} imagens extraídas de um vídeo. Encontre o ROSTO da pessoa principal (a que fala ou aparece com mais destaque).

Retorne as coordenadas do bounding box do rosto em formato JSON com valores de 0 a 1000:
{"xmin": <número>, "ymin": <número>, "xmax": <número>, "ymax": <número>}

Se houver múltiplas pessoas, foque na que está mais centralizada ou falando.
Se não encontrar nenhum rosto, retorne {"xmin": 300, "ymin": 150, "xmax": 700, "ymax": 550}.

Retorne APENAS o JSON, sem texto adicional.`;

      const result = await this.geminiModel.generateContent([prompt, ...imageParts]);
      const response = await result.response;
      let text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();

      this.logger.log(`Gemini face detection response: ${text}`);

      try {
        const coords = JSON.parse(text);
        const xMin = (coords.xmin || 300) / 1000;
        const xMax = (coords.xmax || 700) / 1000;
        const yMin = (coords.ymin || 150) / 1000;
        const yMax = (coords.ymax || 550) / 1000;
        const xCenter = (xMin + xMax) / 2;
        const yCenter = (yMin + yMax) / 2;

        this.logger.log(`Face position: xCenter=${xCenter.toFixed(3)}, yCenter=${yCenter.toFixed(3)}`);

        return {
          xCenter: Math.max(0.1, Math.min(0.9, xCenter)),
          yCenter: Math.max(0.1, Math.min(0.9, yCenter)),
        };
      } catch (e) {
        this.logger.error(`Failed to parse Gemini face detection response: ${text}`);
        return { xCenter: 0.5, yCenter: 0.35 };
      }

    } catch (error) {
      this.logger.error(`Face detection error: ${error.message}`);
      return { xCenter: 0.5, yCenter: 0.35 };
    } finally {
      // Cleanup temp frames
      for (const p of framePaths) {
        try { fs.unlinkSync(p); } catch { }
      }
    }
  }
}
