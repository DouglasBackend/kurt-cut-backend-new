import { Injectable, Logger } from "@nestjs/common";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

const execAsync = promisify(exec);

export interface AudioFeatures {
  energy_peaks: Array<{ timestamp: number; energy: number }>;
  silence_segments: Array<{ start: number; end: number }>;
  average_energy: number;
  dynamic_range: number;
  loudness_timeline: Array<{ time: number; loudness: number }>;
  beat_timestamps: number[];
}

@Injectable()
export class AudioAnalysisService {
  private readonly logger = new Logger(AudioAnalysisService.name);

  async extractFeatures(filePath: string): Promise<AudioFeatures | null> {
    if (!filePath || !fs.existsSync(filePath)) {
      this.logger.warn(`Audio analysis: file not found — ${filePath}`);
      return null;
    }
    try {
      const [silenceData, loudnessData] = await Promise.all([
        this.detectSilence(filePath),
        this.extractLoudnessTimeline(filePath),
      ]);
      const energyPeaks = this.detectEnergyPeaks(loudnessData);
      const avgEnergy = loudnessData.length
        ? loudnessData.reduce((s, p) => s + p.loudness, 0) / loudnessData.length
        : 0;
      const loudnesses = loudnessData.map((p) => p.loudness);
      const dynamicRange =
        loudnesses.length > 1 ? Math.max(...loudnesses) - Math.min(...loudnesses) : 0;
      return {
        energy_peaks: energyPeaks,
        silence_segments: silenceData,
        average_energy: avgEnergy,
        dynamic_range: dynamicRange,
        loudness_timeline: loudnessData,
        beat_timestamps: energyPeaks.map((p) => p.timestamp),
      };
    } catch (err) {
      this.logger.error(`Audio analysis failed: ${err.message}`);
      return null;
    }
  }

  private async extractLoudnessTimeline(filePath: string): Promise<Array<{ time: number; loudness: number }>> {
    try {
      const nullOut = process.platform === "win32" ? "NUL" : "/dev/null";
      const cmd = `ffmpeg -i "${filePath}" -af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" -f null ${nullOut} 2>&1`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 90000 }).catch(
        (e) => ({ stdout: e.stdout || "", stderr: e.stderr || "" })
      );
      const combined = stdout + stderr;
      const timeline: Array<{ time: number; loudness: number }> = [];
      const rmsMatches = [...combined.matchAll(/pts_time:([\d.]+)[^\n]*\nlavfi\.astats\.Overall\.RMS_level=([-\d.inf]+)/g)];
      for (const m of rmsMatches) {
        const t = parseFloat(m[1]);
        const lvl = parseFloat(m[2]);
        if (isFinite(t) && isFinite(lvl)) timeline.push({ time: t, loudness: lvl });
      }
      if (timeline.length > 0) return timeline;
      // Fallback: sample loudness every 1s using volumedetect chunks
      return this.extractLoudnessByChunks(filePath);
    } catch (err) {
      this.logger.warn(`Loudness extraction failed: ${err.message}`);
      return [];
    }
  }

  private async extractLoudnessByChunks(filePath: string): Promise<Array<{ time: number; loudness: number }>> {
    try {
      const nullOut = process.platform === "win32" ? "NUL" : "/dev/null";
      const cmd = `ffmpeg -i "${filePath}" -af "ebur128=framelog=verbose" -f null ${nullOut} 2>&1`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 90000 }).catch(
        (e) => ({ stdout: e.stdout || "", stderr: e.stderr || "" })
      );
      const combined = stdout + stderr;
      const timeline: Array<{ time: number; loudness: number }> = [];
      const matches = [...combined.matchAll(/t:\s*([\d.]+)\s+M:\s*([-\d.]+)/g)];
      for (const m of matches) {
        const t = parseFloat(m[1]);
        const lvl = parseFloat(m[2]);
        if (isFinite(t) && isFinite(lvl)) timeline.push({ time: t, loudness: lvl });
      }
      return timeline;
    } catch {
      return [];
    }
  }

  private detectEnergyPeaks(
    timeline: Array<{ time: number; loudness: number }>,
    topN = 10,
  ): Array<{ timestamp: number; energy: number }> {
    if (!timeline.length) return [];
    const avg = timeline.reduce((s, p) => s + p.loudness, 0) / timeline.length;
    const threshold = avg + 3;
    const peaks: Array<{ timestamp: number; energy: number }> = [];
    for (let i = 1; i < timeline.length - 1; i++) {
      const prev = timeline[i - 1].loudness;
      const curr = timeline[i].loudness;
      const next = timeline[i + 1].loudness;
      if (curr > threshold && curr >= prev && curr >= next) {
        peaks.push({ timestamp: timeline[i].time, energy: curr });
      }
    }
    return peaks.sort((a, b) => b.energy - a.energy).slice(0, topN);
  }

  private async detectSilence(filePath: string, noiseDb = -40, minDuration = 0.5): Promise<Array<{ start: number; end: number }>> {
    try {
      const nullOut = process.platform === "win32" ? "NUL" : "/dev/null";
      const cmd = `ffmpeg -i "${filePath}" -af "silencedetect=n=${noiseDb}dB:d=${minDuration}" -f null ${nullOut}`;
      const { stderr } = await execAsync(cmd, { timeout: 60000 }).catch((e) => ({
        stdout: e.stdout || "", stderr: e.stderr || "",
      }));
      const silences: Array<{ start: number; end: number }> = [];
      const startMatches = [...(stderr.matchAll(/silence_start: ([\d.]+)/g) || [])];
      const endMatches = [...(stderr.matchAll(/silence_end: ([\d.]+)/g) || [])];
      for (let i = 0; i < startMatches.length; i++) {
        const start = parseFloat(startMatches[i][1]);
        const end = endMatches[i] ? parseFloat(endMatches[i][1]) : start + minDuration;
        silences.push({ start, end });
      }
      return silences;
    } catch (err) {
      this.logger.warn(`Silence detection skipped: ${err.message}`);
      return [];
    }
  }
}
