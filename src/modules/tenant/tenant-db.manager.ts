import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { Projeto } from '../../entities/projeto.entity';
import { Video } from '../../entities/video.entity';
import { Corte } from '../../entities/corte.entity';
import { Legenda } from '../../entities/legenda.entity';
import { ContaYoutube } from '../../entities/conta_youtube.entity';

@Injectable()
export class TenantDbManager implements OnModuleDestroy {
  private dataSources = new Map<string, DataSource>();
  private initPromises = new Map<string, Promise<DataSource>>();
  private readonly logger = new Logger('TenantDbManager');

  constructor(private configService: ConfigService) {}

  async getTenantDataSource(usuarioId: string): Promise<DataSource> {
    const secret = this.configService.get<string>('SECRET_TENANT', 'kurt_');
    const dbName = `${secret}${usuarioId.replace(/-/g, '_')}`;

    this.logger.log(
      `[Tenant] Selecting database: ${dbName} for user: ${usuarioId}`,
    );

    if (this.dataSources.has(dbName)) {
      const existing = this.dataSources.get(dbName);
      if (existing && existing.isInitialized) return existing;
    }

    if (this.initPromises.has(dbName)) {
      return this.initPromises.get(dbName)!;
    }

    const initPromise = (async () => {
      const host = this.configService.get<string>('GLOBAL_DB_HOST')!;
      const port = parseInt(
        this.configService.get<string>('GLOBAL_DB_PORT') || '5432',
      );
      const username = this.configService.get<string>('GLOBAL_DB_USER')!;
      const password = this.configService.get<string>('GLOBAL_DB_PASS')!;

      // ── Auto-create tenant database if it doesn't exist ──────────────────
      this.logger.log(`[Tenant] Checking if database ${dbName} exists...`);
      const adminDs = new DataSource({
        type: 'postgres',
        host,
        port,
        username,
        password,
        database: 'postgres',
        ...(host !== 'localhost' && host !== '127.0.0.1' ? {
          ssl: { rejectUnauthorized: false },
          extra: { ssl: { rejectUnauthorized: false } },
        } : {}),
      });

      try {
        await adminDs.initialize();
        const exists = await adminDs.query(
          `SELECT 1 FROM pg_database WHERE datname = $1`,
          [dbName],
        );
        if (exists.length === 0) {
          // this.logger.log(`[Tenant] Database ${dbName} not found. Attempting to create...`);
          await adminDs.query(`CREATE DATABASE "${dbName}"`);
          // this.logger.log(`[Tenant] Database ${dbName} created successfully.`);
        }
      } catch (err) {
        this.logger.warn(
          `[Tenant] Administrative check/create failed for ${dbName}: ${err.message}. Proceeding to direct connection.`,
        );
      } finally {
        if (adminDs.isInitialized) await adminDs.destroy();
      }

      this.logger.log(`[Tenant] Connecting to tenant database: ${dbName}...`);
      const dataSource = new DataSource({
        type: 'postgres',
        host,
        port,
        username,
        password,
        database: dbName,
        entities: [Projeto, Video, Corte, Legenda, ContaYoutube],
        synchronize: true,
        ...(host !== 'localhost' && host !== '127.0.0.1' ? {
          ssl: { rejectUnauthorized: false },
          extra: { ssl: { rejectUnauthorized: false } },
        } : {}),
      });

      await dataSource.initialize();
      this.dataSources.set(dbName, dataSource);
      return dataSource;
    })();

    this.initPromises.set(dbName, initPromise);

    try {
      return await initPromise;
    } finally {
      this.initPromises.delete(dbName);
    }
  }

  async onModuleDestroy() {
    for (const [name, ds] of this.dataSources.entries()) {
      if (ds.isInitialized) {
        await ds.destroy();
      }
    }
    this.dataSources.clear();
  }
}
