import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private uploadDir: string;
  private backendUrl: string;

  constructor(private configService: ConfigService) {
    this.uploadDir = this.configService.get<string>('UPLOAD_DIR', 'upload');
    this.backendUrl = this.configService.get<string>(
      'BACKEND_URL',
      'http://localhost:3001',
    );

    this.logger.log(
      `[StorageService] Local storage initialized. Dir: ${this.uploadDir}, URL: ${this.backendUrl}`,
    );

    // Ensure the main upload directory exists
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

    // Remove leading slash if present
    const cleanPath = filePath.startsWith('/')
      ? filePath.substring(1)
      : filePath;

    // Normalize path separators to forward slashes for URLs
    const urlPath = cleanPath.replace(/\\/g, '/');

    const url = `${this.backendUrl}/${this.uploadDir}/${urlPath}`;
    // this.logger.debug(`Generated public URL for ${filePath}: ${url}`);
    return url;
  }

  async getSignedUrl(filePath: string, expiresIn = 3600): Promise<string> {
    return this.getPublicUrl(filePath);
  }

  async downloadFile(storagePath: string, localPath: string): Promise<void> {
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
