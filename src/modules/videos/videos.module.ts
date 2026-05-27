import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { TranscriptionModule } from '../transcription/transcription.module';
import { CreditsModule } from '../credits/credits.module';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { TenantModule } from '../tenant/tenant.module';

import { TypeOrmModule } from '@nestjs/typeorm';
import { Usuario } from '../../entities/usuario.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Usuario]),
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
    TranscriptionModule,
    CreditsModule,
    TenantModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule { }
