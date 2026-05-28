import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private supabase: SupabaseClient;
  private bucketName: string;
  private tempDir: string;

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        '[StorageService] SUPABASE_URL e SUPABASE_KEY são obrigatórios na .env. O sistema utiliza 100% Supabase Storage.',
      );
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.bucketName = this.configService.get<string>(
      'SUPABASE_BUCKET',
      'kurt-cut-storage',
    );

    // Diretório temporário para processamento FFmpeg (local, limpo após uso)
    this.tempDir = path.join(os.tmpdir(), 'kurt-cut-tmp');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    this.logger.log(
      `[StorageService] Supabase Storage inicializado. Bucket: ${this.bucketName}, Temp: ${this.tempDir}`,
    );
  }

  async onModuleInit() {
    await this.ensureBucketExists();
  }

  /**
   * Garante que o bucket exista no Supabase Storage, criando-o se necessário.
   */
  private async ensureBucketExists(): Promise<void> {
    try {
      const { data, error } = await this.supabase.storage.getBucket(
        this.bucketName,
      );

      if (error && error.message?.includes('not found')) {
        this.logger.log(
          `[StorageService] Bucket "${this.bucketName}" não encontrado. Criando...`,
        );
        const { error: createError } = await this.supabase.storage.createBucket(
          this.bucketName,
          {
            public: true,
          },
        );

        if (createError) {
          this.logger.error(
            `[StorageService] Falha ao criar bucket: ${createError.message}`,
          );
        } else {
          this.logger.log(
            `[StorageService] Bucket "${this.bucketName}" criado com sucesso.`,
          );
        }
      } else if (data) {
        this.logger.log(
          `[StorageService] Bucket "${this.bucketName}" já existe. Atualizando para torná-lo público...`,
        );
        const { error: updateError } = await this.supabase.storage.updateBucket(this.bucketName, {
          public: true,
        });
        if (updateError) {
          this.logger.warn(`[StorageService] Falha ao atualizar permissões do bucket: ${updateError.message}`);
        }
      } else if (error) {
        this.logger.warn(
          `[StorageService] Erro ao verificar bucket: ${error.message}`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `[StorageService] Não foi possível verificar/criar bucket: ${e.message}`,
      );
    }
  }

  /**
   * Retorna o diretório temporário local para processamento FFmpeg.
   * Cria subdiretórios automaticamente conforme necessário.
   */
  getTempDir(subPath?: string): string {
    const dir = subPath ? path.join(this.tempDir, subPath) : this.tempDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Retorna um caminho temporário local para um arquivo.
   */
  getTempPath(relativePath: string): string {
    const fullPath = path.join(this.tempDir, relativePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return fullPath;
  }

  /**
   * Upload de arquivo para o Supabase Storage.
   */
  async uploadFile(
    filePath: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const cleanPath = filePath.replace(/\\/g, '/');
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

    if (error) {
      this.logger.error(
        `Falha ao enviar arquivo para o Supabase: ${cleanPath}: ${error.message}`,
      );
      throw error;
    }

    return cleanPath;
  }

  /**
   * Exclui um arquivo do Supabase Storage.
   */
  async deleteFile(filePath: string): Promise<void> {
    const cleanPath = filePath.replace(/\\/g, '/');
    this.logger.log(`Excluindo arquivo no Supabase: ${cleanPath}`);

    const { error } = await this.supabase.storage
      .from(this.bucketName)
      .remove([cleanPath]);

    if (error) {
      this.logger.error(
        `Falha ao excluir arquivo no Supabase ${cleanPath}: ${error.message}`,
      );
    }
  }

  /**
   * Exclui todos os arquivos de uma pasta no Supabase Storage.
   */
  async deleteFolder(folderPath: string): Promise<void> {
    const cleanPath = folderPath.replace(/\\/g, '/');
    this.logger.log(`Excluindo pasta no Supabase: ${cleanPath}`);

    try {
      const { data: files, error: listError } = await this.supabase.storage
        .from(this.bucketName)
        .list(cleanPath, { limit: 1000 });

      if (listError) {
        this.logger.warn(
          `Falha ao listar pasta ${cleanPath}: ${listError.message}`,
        );
        return;
      }

      if (!files || files.length === 0) {
        this.logger.log(`Pasta ${cleanPath} vazia ou não encontrada.`);
        return;
      }

      // Recursivamente listar subpastas
      const allFiles: string[] = [];
      for (const file of files) {
        const filePath = `${cleanPath}/${file.name}`;
        if (file.id) {
          // É um arquivo (tem id)
          allFiles.push(filePath);
        } else {
          // É uma pasta, recursivamente listar
          const subFiles = await this.listAllFiles(filePath);
          allFiles.push(...subFiles);
        }
      }

      if (allFiles.length > 0) {
        // Supabase remove aceita até 1000 arquivos por vez
        const batches: string[][] = [];
        for (let i = 0; i < allFiles.length; i += 100) {
          batches.push(allFiles.slice(i, i + 100));
        }

        for (const batch of batches) {
          const { error } = await this.supabase.storage
            .from(this.bucketName)
            .remove(batch);
          if (error) {
            this.logger.warn(
              `Falha ao excluir batch de arquivos: ${error.message}`,
            );
          }
        }

        this.logger.log(
          `Excluídos ${allFiles.length} arquivos da pasta ${cleanPath}.`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Erro ao excluir pasta ${cleanPath}: ${e.message}`,
      );
    }
  }

  /**
   * Lista recursivamente todos os arquivos em uma pasta do Supabase Storage.
   */
  private async listAllFiles(folderPath: string): Promise<string[]> {
    const allFiles: string[] = [];

    const { data: files, error } = await this.supabase.storage
      .from(this.bucketName)
      .list(folderPath, { limit: 1000 });

    if (error || !files) return allFiles;

    for (const file of files) {
      const filePath = `${folderPath}/${file.name}`;
      if (file.id) {
        allFiles.push(filePath);
      } else {
        const subFiles = await this.listAllFiles(filePath);
        allFiles.push(...subFiles);
      }
    }

    return allFiles;
  }

  /**
   * Retorna a URL pública de um arquivo no Supabase Storage.
   */
  getPublicUrl(filePath: string): string {
    if (!filePath) return '';
    if (filePath.startsWith('http')) return filePath;

    const cleanPath = filePath.replace(/\\/g, '/');
    const { data } = this.supabase.storage
      .from(this.bucketName)
      .getPublicUrl(cleanPath);

    return data.publicUrl;
  }

  /**
   * Retorna uma URL assinada (temporária) para um arquivo no Supabase Storage.
   */
  async getSignedUrl(filePath: string, expiresIn = 3600): Promise<string> {
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

  /**
   * Baixa um arquivo do Supabase Storage para um caminho local.
   * Usado para processamento FFmpeg que precisa de arquivos locais.
   */
  async downloadFile(storagePath: string, localPath: string): Promise<void> {
    const cleanPath = storagePath.replace(/\\/g, '/');

    this.logger.log(
      `Baixando arquivo do Supabase: ${cleanPath} para ${localPath}`,
    );

    const { data, error } = await this.supabase.storage
      .from(this.bucketName)
      .download(cleanPath);

    if (error) {
      this.logger.error(
        `Falha ao baixar arquivo do Supabase ${cleanPath}: ${error.message}`,
      );
      throw error;
    }

    if (!data) {
      throw new Error(`Dados vazios retornados pelo Supabase para: ${cleanPath}`);
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    const targetDir = path.dirname(localPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(localPath, buffer);

    this.logger.log(
      `Arquivo baixado com sucesso: ${cleanPath} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`,
    );
  }

  /**
   * Obtém o Buffer de um arquivo diretamente do Supabase Storage (sem salvar localmente).
   */
  async getFileBuffer(storagePath: string): Promise<Buffer> {
    const cleanPath = storagePath.replace(/\\/g, '/');

    const { data, error } = await this.supabase.storage
      .from(this.bucketName)
      .download(cleanPath);

    if (error) throw error;
    if (!data) throw new Error(`Dados vazios para: ${cleanPath}`);

    return Buffer.from(await data.arrayBuffer());
  }

  /**
   * Limpa um arquivo temporário local de forma segura.
   */
  cleanupTempFile(filePath: string): void {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`Arquivo temporário removido: ${filePath}`);
      }
    } catch (e) {
      this.logger.warn(`Falha ao remover arquivo temporário ${filePath}: ${e.message}`);
    }
  }

  /**
   * Limpa um diretório temporário local de forma segura.
   */
  cleanupTempDir(dirPath: string): void {
    try {
      if (dirPath && fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        this.logger.debug(`Diretório temporário removido: ${dirPath}`);
      }
    } catch (e) {
      this.logger.warn(`Falha ao remover diretório temporário ${dirPath}: ${e.message}`);
    }
  }
}
