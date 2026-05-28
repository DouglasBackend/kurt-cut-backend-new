// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

// Entities pt-BR
import { Usuario } from './entities/usuario.entity';

// Modules
import { AuthModule } from './modules/auth/auth.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { QueueModule } from './modules/queue/queue.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { VideosModule } from './modules/videos/videos.module';
import { ClipsModule } from './modules/clips/clips.module';
import { TranscriptionModule } from './modules/transcription/transcription.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { YoutubeModule } from './modules/youtube/youtube.module';
import { RedisModule } from './modules/redis/redis.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { CreditsModule } from './modules/credits/credits.module';
import { BillingModule } from './modules/billing/billing.module';
import { StorageModule } from './common/storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    // ── Single PostgreSQL DB (kurtcut_db) ────────────────
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const host = config.get('GLOBAL_DB_HOST');
        const user = config.get('GLOBAL_DB_USER');
        const dbName = config.get('GLOBAL_DB_NAME');

        console.log(`[Database] Connecting to ${host} as ${user} (DB: ${dbName})`);
        if (!user || user === 'postgres') {
          console.warn(`[Database] WARNING: GLOBAL_DB_USER is "${user}". This might be a mistake if you are using Supabase.`);
        }

        return {
          type: 'postgres',
          host,
          port: parseInt(config.get('GLOBAL_DB_PORT') || '5432'),
          username: user,
          password: config.get('GLOBAL_DB_PASS'),
          database: dbName,
          entities: [Usuario],
          synchronize: true,
          logging: false,
          ...(host !== 'localhost' && host !== '127.0.0.1' ? {
            ssl: { rejectUnauthorized: false },
            extra: {
              ssl: { rejectUnauthorized: false },
            },
          } : {}),
        };
      },
      inject: [ConfigService],
    }),

    // ── Redis / Bull ─────────────────────────────────────────────────────
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL');
        if (redisUrl) {
          const isTls = redisUrl.startsWith('rediss://');
          return {
            redis: {
              ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
              maxRetriesPerRequest: null,
            },
            url: redisUrl, // O bull aceita a URL na raiz do config
          } as any;
        }
        const password = config.get('REDIS_PASSWORD', '');
        return {
          redis: {
            host: config.get('REDIS_HOST', '127.0.0.1'),
            port: parseInt(config.get('REDIS_PORT', '6379')),
            ...(password ? { password } : {}),
            maxRetriesPerRequest: null, // Recomendado para Bull/BullMQ
          },
        };
      },
      inject: [ConfigService],
    }),

    // Feature modules
    TenantModule,
    RedisModule,
    AuthModule,
    GatewayModule,
    QueueModule,
    CreditsModule,
    ProjectsModule,
    VideosModule,
    ClipsModule,
    TranscriptionModule,
    AnalysisModule,
    YoutubeModule,
    StorageModule,
    BillingModule,
  ],
})
export class AppModule {
  constructor() {
    console.log('[AppModule] Initialized');
  }
}
