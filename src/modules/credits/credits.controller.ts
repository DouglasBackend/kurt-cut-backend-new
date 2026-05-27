import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreditsService } from './credits.service';

@Controller('api/credits')
@UseGuards(JwtAuthGuard)
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get('balance')
  async getBalance(@Request() req) {
    const balance = await this.creditsService.getBalance(req.user.id);
    return { credits: balance };
  }
}
