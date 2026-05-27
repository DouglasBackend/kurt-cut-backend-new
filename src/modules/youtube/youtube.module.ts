import { Module } from '@nestjs/common';
import { YoutubeService } from './youtube.service';
import { YoutubeController } from './youtube.controller';
import { ConfigModule } from '@nestjs/config';

@Module({
    imports: [ConfigModule],
    providers: [YoutubeService],
    controllers: [YoutubeController],
    exports: [YoutubeService],
})
export class YoutubeModule { }
