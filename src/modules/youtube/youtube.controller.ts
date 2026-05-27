import { Controller, Get, Post, Patch, Delete, Body, Query, Redirect, UseGuards, Request, Res, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { YoutubeService } from './youtube.service';

@Controller('api/youtube')
export class YoutubeController {
  constructor(private readonly youtubeService: YoutubeService) { }

  @Get('auth')
  @UseGuards(JwtAuthGuard)
  @Redirect()
  auth(@Request() req) {
    const url = this.youtubeService.getAuthUrl(req.user.id);
    return { url };
  }

  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: any) {
    // state contém o usuarioId
    await this.youtubeService.handleCallback(code, state);
    res.redirect(`${process.env.APP_URL || 'http://localhost:3000'}/integrations?success=true`);
  }


  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@Request() req) {
    return this.youtubeService.getConnectedAccount(req.user.id);
  }

  @Patch('status')
  @UseGuards(JwtAuthGuard)
  update(@Request() req, @Body() body: { nome_canal: string }) {
    return this.youtubeService.updateAccount(req.user.id, body.nome_canal);
  }

  @Delete('disconnect')
  @UseGuards(JwtAuthGuard)
  disconnect(@Request() req) {
    return this.youtubeService.disconnectAccount(req.user.id);
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  upload(
    @Request() req,
    @Body() body: { filePath: string; title: string; description: string; privacyStatus: 'public' | 'private' | 'unlisted'; clipId?: string }
  ) {
    return this.youtubeService.uploadVideo(req.user.id, body.filePath, body.title, body.description, body.privacyStatus, undefined, body.clipId);
  }

}
