// src/modules/redis/redis.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private redisClient: Redis;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (redisUrl) {
      const isTls = redisUrl.startsWith('rediss://');
      this.redisClient = new Redis(redisUrl, {
        ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
        maxRetriesPerRequest: null,
      });
    } else {
      const password = this.configService.get('REDIS_PASSWORD', '');
      this.redisClient = new Redis({
        host: this.configService.get('REDIS_HOST', '127.0.0.1'),
        port: parseInt(this.configService.get('REDIS_PORT', '6379')),
        ...(password ? { password } : {}),
      });
    }
  }

  onModuleDestroy() {
    this.redisClient.disconnect();
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redisClient.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redisClient.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  async del(key: string): Promise<void> {
    await this.redisClient.del(key);
  }
}
