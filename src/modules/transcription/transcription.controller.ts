import { Controller, Get, Param } from '@nestjs/common';
import { TranscriptionService } from './transcription.service';

@Controller('api/transcription')
export class TranscriptionController {
  constructor(private readonly transcriptionService: TranscriptionService) {}

  @Get(':id/status')
  getStatus(@Param('id') id: string) {
    return this.transcriptionService.getStatus(id);
  }

  @Get(':id/srt')
  getSRT(@Param('id') id: string) {
    return this.transcriptionService.getSubtitlesSRT(id);
  }

  @Get(':id/vtt')
  getVTT(@Param('id') id: string) {
    return this.transcriptionService.getSubtitlesVTT(id);
  }
}
