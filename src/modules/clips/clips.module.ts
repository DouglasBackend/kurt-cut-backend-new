import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ClipsController } from './clips.controller';
import { ClipsService } from './clips.service';
import { FFmpegSubtitleService } from './ffmpeg-subtitle.service';
import { CanvasSubtitleService } from './canvas-subtitle.service';
import { GatewayModule } from '../gateway/gateway.module';
import { CreditsModule } from '../credits/credits.module';
import { CLIP_EXPORT_QUEUE } from '../queue/queue.constants';
import { TenantModule } from '../tenant/tenant.module';

import { TypeOrmModule } from '@nestjs/typeorm';
import { Usuario } from '../../entities/usuario.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Usuario]),
    ConfigModule,
    BullModule.registerQueue({ name: CLIP_EXPORT_QUEUE }),
    GatewayModule,
    CreditsModule,
    TenantModule,
    require('../analysis/analysis.module').AnalysisModule,
  ],
  controllers: [ClipsController],
  providers: [ClipsService, FFmpegSubtitleService, CanvasSubtitleService],
  exports: [ClipsService],
})
export class ClipsModule { }
