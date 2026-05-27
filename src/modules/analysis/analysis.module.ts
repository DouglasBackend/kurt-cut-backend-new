import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AnalysisService } from "./analysis.service";
import { AudioAnalysisService } from "./audio-analysis.service";
import { FaceDetectionService } from "./face-detection.service";
import { StorageModule } from "../../common/storage/storage.module";

@Module({
  imports: [ConfigModule, StorageModule],
  providers: [AnalysisService, AudioAnalysisService, FaceDetectionService],
  exports: [AnalysisService, AudioAnalysisService, FaceDetectionService],
})
export class AnalysisModule {}
