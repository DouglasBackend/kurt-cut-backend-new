import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private supabase: SupabaseClient | null = null;
  private bucketName: string;
  private uploadDir: string;
  private backendUrl: string;

  constructor(private configService: ConfigService) {
    this.uploadDir = this.configService.get<string>('UPLOAD_DIR', 'upload');
    this.backendUrl = this.configService.get<string>(
      'BACKEND_URL',
      'http://localhost:3001',
    );
    this.bucketName = this.configService.get<string>(
      'SUPABASE_BUCKET',
      'kurt-cut-storage',
    );

    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_KEY');

    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
      this.logger.log(
        `[StorageService] Supabase Storage initialized. Bucket: ${this.bucketName}`,
      );
    } else {
      this.logger.log(
        `[StorageService] Supabase credentials missing. Local storage initialized. Dir: ${this.uploadDir}, URL: ${this.backendUrl}`,
      );
    }

    // Ensure the main upload directory exists (used for local fallback or temp files during processing)
    const absolutePath = this.getAbsoluteUploadDir();
    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
      this.logger.log(`Diretório de upload criado: ${absolutePath}`);
    }
  }

  public getAbsoluteUploadDir(): string {
    return path.isAbsolute(this.uploadDir)
      ? this.uploadDir
      : path.join(process.cwd(), this.uploadDir);
  }

  public getAbsolutePath(relativeFile: string): string {
    return path.join(this.getAbsoluteUploadDir(), relativeFile);
  }

  async uploadFile(
    filePath: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const cleanPath = filePath.replace(/\\/g, '/');

    if (this.supabase) {
      try {
        const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
        this.logger.log(
          `Enviando arquivo para o Supabase Storage: ${cleanPath} (${sizeMB} MB)`,
        );

        const { error } = await this.supabase.storage
          .from(this.bucketName)
          .upload(cleanPath, buffer, {
            contentType,
            upsert: true,
          });

        if (error) throw error;
        return cleanPath;
      } catch (e) {
        this.logger.error(
          `Falha ao enviar arquivo para o Supabase: ${cleanPath}: ${e.message}`,
        );
        throw e;
      }
    }

    // Local Fallback
    try {
      const absoluteUploadDir = this.getAbsoluteUploadDir();
      const targetPath = path.join(absoluteUploadDir, filePath);
      const parentDir = path.dirname(targetPath);

      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      this.logger.log(
        `Enviando arquivo para o Local: ${targetPath} (${sizeMB} MB)`,
      );

      fs.writeFileSync(targetPath, buffer);
      return filePath;
    } catch (e) {
      this.logger.error(
        `Falha ao enviar arquivo para o Local: ${filePath}: ${e.message}`,
      );
      throw e;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const cleanPath = filePath.replace(/\\/g, '/');

    if (this.supabase) {
      try {
        this.logger.log(`Excluindo arquivo no Supabase: ${cleanPath}`);
        const { error } = await this.supabase.storage
          .from(this.bucketName)
          .remove([cleanPath]);
        if (error) throw error;
        return;
      } catch (e) {
        this.logger.error(
          `Falha ao excluir arquivo no Supabase ${cleanPath}: ${e.message}`,
        );
      }
      return;
    }

    // Local Fallback
    try {
      const absoluteUploadDir = this.getAbsoluteUploadDir();
      const targetPath = path.join(absoluteUploadDir, filePath);

      if (fs.existsSync(targetPath)) {
        this.logger.log(`Excluindo arquivo local: ${targetPath}`);
        fs.unlinkSync(targetPath);
      } else {
        this.logger.warn(`Arquivo não encontrado para exclusão: ${targetPath}`);
      }
    } catch (e) {
      this.logger.error(
        `Falha ao excluir arquivo local ${filePath}: ${e.message}`,
      );
    }
  }

  getPublicUrl(filePath: string): string {
    if (!filePath) return '';
    if (filePath.startsWith('http')) return filePath;

    const cleanPath = filePath.replace(/\\/g, '/');

    if (this.supabase) {
      const { data } = this.supabase.storage
        .from(this.bucketName)
        .getPublicUrl(cleanPath);
      return data.publicUrl;
    }

    // Local Fallback
    const relativePath = cleanPath.startsWith('/')
      ? cleanPath.substring(1)
      : cleanPath;
    return `${this.backendUrl}/${this.uploadDir}/${relativePath}`;
  }

  async getSignedUrl(filePath: string, expiresIn = 3600): Promise<string> {
    if (this.supabase) {
      try {
        const cleanPath = filePath.replace(/\\/g, '/');
        const { data, error } = await this.supabase.storage
          .from(this.bucketName)
          .createSignedUrl(cleanPath, expiresIn);
        if (error) throw error;
        return data.signedUrl;
      } catch {
        return this.getPublicUrl(filePath);
      }
    }
    return this.getPublicUrl(filePath);
  }

  async downloadFile(storagePath: string, localPath: string): Promise<void> {
    const cleanPath = storagePath.replace(/\\/g, '/');

    if (this.supabase) {
      try {
        this.logger.log(
          `Baixando arquivo do Supabase: ${cleanPath} para ${localPath}`,
        );
        const { data, error } = await this.supabase.storage
          .from(this.bucketName)
          .download(cleanPath);

        if (error) throw error;
        if (!data) throw new Error('Dados vazios retornados pelo Supabase');

        const buffer = Buffer.from(await data.arrayBuffer());
        const targetDir = path.dirname(localPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.writeFileSync(localPath, buffer);
        return;
      } catch (e) {
        this.logger.error(
          `Falha ao baixar arquivo do Supabase ${cleanPath}: ${e.message}`,
        );
        // Tenta continuar com o local caso haja cache/sincronia
      }
    }

    // Local Fallback
    try {
      const absoluteUploadDir = this.getAbsoluteUploadDir();
      const sourcePath = path.join(absoluteUploadDir, storagePath);

      if (!fs.existsSync(sourcePath)) {
        const absLocal = path.resolve(localPath);
        const absSource = path.resolve(sourcePath);

        if (absSource === absLocal && fs.existsSync(absLocal)) {
          this.logger.debug(
            `Download redundante: source matches local and exists: ${localPath}`,
          );
          return;
        }
        this.logger.warn(
          `Arquivo não encontrado para download: ${storagePath} (Esperado: ${sourcePath})`,
        );
        return;
      }

      const targetDir = path.dirname(localPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      if (path.resolve(sourcePath) !== path.resolve(localPath)) {
        this.logger.log(
          `Copying local file from ${sourcePath} to ${localPath}`,
        );
        fs.copyFileSync(sourcePath, localPath);
      }
    } catch (e) {
      this.logger.error(
        `Falha ao Copiar o Arquivo para o Local: ${storagePath} para ${localPath}: ${e.message}`,
      );
    }
  }
}
