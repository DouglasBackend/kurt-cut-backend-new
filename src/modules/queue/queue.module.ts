import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { VideoProcessingProcessor, ClipExportProcessor } from './video-processing.processor';
import { VIDEO_QUEUE, CLIP_EXPORT_QUEUE } from './queue.constants';
import { TranscriptionModule } from '../transcription/transcription.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { ClipsModule } from '../clips/clips.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: VIDEO_QUEUE,
        settings: {
          stalledInterval: 60000,
          maxStalledCount: 5,
        },
      },
      {
        name: CLIP_EXPORT_QUEUE,
        settings: {
          stalledInterval: 60000,
          maxStalledCount: 5,
        },
      },
    ),
    TranscriptionModule,
    AnalysisModule,
    ClipsModule,
    GatewayModule,
  ],
  providers: [VideoProcessingProcessor, ClipExportProcessor],
  exports: [VideoProcessingProcessor],
})
export class QueueModule { }
