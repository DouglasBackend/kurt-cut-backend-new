import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { ContaYoutube } from '../../entities/conta_youtube.entity';
import { Corte } from '../../entities/corte.entity';
import { Video } from '../../entities/video.entity';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { TenantDbManager } from '../tenant/tenant-db.manager';
import { StorageService } from '../../common/storage/storage.service';

@Injectable()
export class YoutubeService {
    private readonly logger = new Logger(YoutubeService.name);
    private oauth2Client: OAuth2Client;
    private gemini: GoogleGenerativeAI;
    private geminiModel: GenerativeModel;

    constructor(
        private readonly configService: ConfigService,
        private readonly tenantDb: TenantDbManager,
        private readonly storageService: StorageService,
    ) {
        const clientId = this.configService.get<string>('YOUTUBE_CLIENT_ID');
        const clientSecret = this.configService.get<string>('YOUTUBE_CLIENT_SECRET');
        const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3001');
        const redirectUri = this.configService.get<string>('YOUTUBE_REDIRECT_URI') || `${appUrl}/api/youtube/callback`;
        this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

        // Inicializar Gemini AI para geração de tags
        this.gemini = new GoogleGenerativeAI(this.configService.get<string>('GEMINI_API_KEY', ''));
        this.geminiModel = this.gemini.getGenerativeModel({ model: 'gemini-2.0-flash' });
    }

    private async getContasRepo(usuarioId: string): Promise<Repository<ContaYoutube>> {
        const ds = await this.tenantDb.getTenantDataSource(usuarioId);
        return ds.getRepository(ContaYoutube);
    }

    getAuthUrl(usuarioId: string): string {
        const scopes = [
            'https://www.googleapis.com/auth/youtube.upload',
            'https://www.googleapis.com/auth/youtube.readonly',
        ];

        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent',
            state: usuarioId, // Passar o ID no state para recuperar no callback
        });
    }

    async handleCallback(code: string, usuarioId: string): Promise<ContaYoutube> {
        this.logger.log(`Handling callback for user: ${usuarioId}`);
        try {
            const { tokens } = await this.oauth2Client.getToken(code);
            this.oauth2Client.setCredentials(tokens);
            this.logger.log(`Tokens received for user: ${usuarioId}`);

            const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });
            const channelResponse = await youtube.channels.list({
                part: ['snippet'],
                mine: true,
            });

            const channel = channelResponse.data.items?.[0];
            if (!channel) {
                throw new BadRequestException('Canal do YouTube não encontrado para essa conta.');
            }

            const channelId = channel.id as string;
            const channelName = channel.snippet?.title || 'Unknown Channel';
            const channelThumbnail = channel.snippet?.thumbnails?.default?.url || '';

            // Verifica se a conta já existe
            const repo = await this.getContasRepo(usuarioId);
            let account = await repo.findOne({ where: { id_canal: channelId, usuario_id: usuarioId } });

            if (account) {
                // Atualiza tokens
                account.access_token = tokens.access_token || account.access_token;
                if (tokens.refresh_token) {
                    account.refresh_token = tokens.refresh_token;
                }
                if (tokens.expiry_date) {
                    account.token_expiracao = tokens.expiry_date;
                }
                account.nome_canal = channelName;
                account.miniatura_canal = channelThumbnail;
            } else {
                // Cria conta
                account = repo.create({
                    id: uuidv4(),
                    usuario_id: usuarioId,
                    id_canal: channelId,
                    nome_canal: channelName,
                    miniatura_canal: channelThumbnail,
                    access_token: tokens.access_token as string,
                    refresh_token: tokens.refresh_token as string,
                    token_expiracao: tokens.expiry_date || 0,
                });
            }

            return await repo.save(account!);

        } catch (error) {
            this.logger.error('Error in YouTube OAuth callback', error);
            throw new BadRequestException('Falha ao autenticar com o YouTube');
        }
    }

    async getConnectedAccount(usuarioId: string): Promise<ContaYoutube | null> {
        this.logger.log(`Fetching connected account for user: ${usuarioId}`);
        const repo = await this.getContasRepo(usuarioId);
        const accounts = await repo.find({
            where: { usuario_id: usuarioId },
            order: { criado_em: 'DESC' },
            take: 1
        });
        
        if (accounts.length > 0) {
            this.logger.log(`Found account for user ${usuarioId}: ${accounts[0].nome_canal}`);
        } else {
            this.logger.warn(`No account found for user ${usuarioId}`);
        }
        
        return accounts[0] || null;
    }

    async updateAccount(usuarioId: string, nome_canal: string): Promise<ContaYoutube> {
        const account = await this.getConnectedAccount(usuarioId);
        if (!account) {
            throw new NotFoundException('Nenhuma conta do YouTube conectada.');
        }

        account.nome_canal = nome_canal;
        const repo = await this.getContasRepo(usuarioId);
        return await repo.save(account);
    }

    async disconnectAccount(usuarioId: string): Promise<void> {
        const account = await this.getConnectedAccount(usuarioId);
        if (account) {
            const repo = await this.getContasRepo(usuarioId);
            await repo.remove(account);
        }
    }

    async uploadVideo(
        usuarioId: string,
        filePath: string,
        title: string,
        description: string,
        privacyStatus: 'public' | 'private' | 'unlisted',
        tags?: string[],
        clipId?: string,
    ): Promise<string> {
        const account = await this.getConnectedAccount(usuarioId);
        if (!account) {
            throw new NotFoundException('Nenhuma conta do YouTube conectada.');
        }

        this.oauth2Client.setCredentials({
            access_token: account.access_token,
            refresh_token: account.refresh_token,
            expiry_date: account.token_expiracao ? Number(account.token_expiracao) : undefined,
        });

        this.oauth2Client.on('tokens', async (tokens) => {
            account.access_token = tokens.access_token as string;
            if (tokens.refresh_token) {
                account.refresh_token = tokens.refresh_token;
            }
            if (tokens.expiry_date) {
                account.token_expiracao = tokens.expiry_date;
            }
            const repo = await this.getContasRepo(usuarioId);
            await repo.save(account);
        });

        // ── Auto-gerar tags e descrição se clipId fornecido ──────────────────
        let finalDescription = description;
        let finalTags = tags || [];

        if (clipId) {
            try {
                const generated = await this.generateTagsForClip(usuarioId, clipId, title);
                if (generated) {
                    finalDescription = this.buildFinalDescription(description, generated.tags, generated.engagementPhrases);
                    finalTags = [...finalTags, ...generated.tags];
                    this.logger.log(`Tags auto-geradas para clip ${clipId}: ${generated.tags.length} tags, ${generated.engagementPhrases.length} frases`);
                }
            } catch (err) {
                this.logger.warn(`Falha ao gerar tags para clip ${clipId}: ${err.message}. Subindo sem tags automáticas.`);
            }
        }

        const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

        // Baixar do Supabase Storage para arquivo temporário local
        const tempDir = this.storageService.getTempDir('youtube_upload');
        const absolutePath = path.join(tempDir, `yt_upload_${Date.now()}${path.extname(filePath)}`);

        try {
            await this.storageService.downloadFile(filePath, absolutePath);
        } catch (e) {
            throw new NotFoundException(`Arquivo de vídeo não encontrado no Supabase Storage: ${filePath}`);
        }

        const fileSize = fs.statSync(absolutePath).size;

        // YouTube titles must be <= 100 characters
        const finalTitle = title.length > 100 ? title.substring(0, 97) + '...' : title;
        this.logger.log(`Uploading to YouTube: Title="${finalTitle}" (${finalTitle.length} chars)`);

        try {
            const res: any = await youtube.videos.insert({
                part: ['snippet', 'status'],
                requestBody: {
                    snippet: {
                        title: finalTitle,
                        description: finalDescription,
                        tags: finalTags.length > 0 ? finalTags : undefined,
                    },
                    status: {
                        privacyStatus,
                    },
                },
                media: {
                    body: fs.createReadStream(absolutePath),
                },
            }, {
                onUploadProgress: evt => {
                    const progress = (evt.bytesRead / fileSize) * 100;
                    this.logger.log(`Upload Progress: ${Math.round(progress)}%`);
                },
            });

            return res.data.id as string;
        } catch (error) {
            this.logger.error('Error uploading video to YouTube', error);
            throw new BadRequestException('Falha ao upar o vídeo no YouTube');
        } finally {
            this.storageService.cleanupTempFile(absolutePath);
        }
    }

    // ── Geração automática de tags via Gemini AI ─────────────────────────────

    private async generateTagsForClip(
        usuarioId: string,
        clipId: string,
        clipTitle: string,
    ): Promise<{ tags: string[]; engagementPhrases: string[] } | null> {
        const ds = await this.tenantDb.getTenantDataSource(usuarioId);
        const corteRepo = ds.getRepository(Corte);
        const videoRepo = ds.getRepository(Video);

        const corte = await corteRepo.findOne({ where: { id: clipId } });
        if (!corte) {
            this.logger.warn(`Clip ${clipId} não encontrado para geração de tags.`);
            return null;
        }

        const video = await videoRepo.findOne({ where: { id: corte.video_id } });
        if (!video) {
            this.logger.warn(`Video pai ${corte.video_id} não encontrado.`);
            return null;
        }

        // Extrair transcrição do trecho do clipe
        const clipTranscript = this.extractClipTranscript(
            video.palavras_transcricao || [],
            corte.tempo_inicio,
            corte.tempo_fim,
        );

        const videoTitle = video.titulo || '';

        return this.generateYoutubeTags(clipTitle, videoTitle, clipTranscript);
    }

    private extractClipTranscript(words: any[], startTime: number, endTime: number): string {
        if (!words || words.length === 0) return '';

        const startMs = startTime * 1000;
        const endMs = endTime * 1000;

        const clipWords = words.filter((w: any) => {
            const wordStart = w.start || 0;
            return wordStart >= startMs && wordStart <= endMs;
        });

        return clipWords.map((w: any) => w.text || '').join(' ').trim();
    }

    private async generateYoutubeTags(
        clipTitle: string,
        videoTitle: string,
        transcript: string,
    ): Promise<{ tags: string[]; engagementPhrases: string[] }> {
        const prompt = `Você é um especialista em SEO para YouTube Shorts e criação de conteúdo viral.
Com base no título e transcrição do clipe abaixo, gere:

1. Entre 15 e 25 tags curtas (1-3 palavras cada) para YouTube SEO. As tags devem ser variadas: inclua o nome do jogo/conteúdo, variações do tema, termos relacionados, gírias da comunidade, e termos genéricos de engajamento.
2. Entre 3 e 5 frases curtas e chamativas de engajamento (estilo clickbait do YouTube Shorts). Essas frases devem gerar curiosidade e vontade de assistir.

Título do Clipe: "${clipTitle}"
Título do Vídeo Original: "${videoTitle}"
Transcrição do Clipe: "${transcript.slice(0, 1500)}"

REGRAS:
- Tags devem ser em minúsculo
- Tags devem ser curtas (1-3 palavras)
- Frases de engajamento devem usar emojis e ser chamativas
- Inclua variações do tema principal (ex: se é GTA, inclua "gta 5", "gta online", "gta roleplay", etc.)
- Inclua termos genéricos virais como "clipes", "melhores momentos", "compilação"
- As frases de engajamento devem parecer títulos alternativos ou comentários provocativos

Retorne APENAS JSON puro sem markdown:
{
  "tags": ["tag1", "tag2", ...],
  "engagement_phrases": ["frase1", "frase2", ...]
}`;

        try {
            const result = await this.geminiModel.generateContent(prompt);
            const response = result.response;
            let text = response.text();
            
            // Limpeza de markdown
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();
            
            const parsed = JSON.parse(text);
            
            return {
                tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: string) => String(t).toLowerCase().trim()).filter(Boolean) : [],
                engagementPhrases: Array.isArray(parsed.engagement_phrases) ? parsed.engagement_phrases.map((p: string) => String(p).trim()).filter(Boolean) : [],
            };
        } catch (error) {
            this.logger.error(`Erro ao gerar tags com Gemini: ${error.message}`);
            // Fallback: retorna tags básicas baseadas no título
            return this.generateFallbackTags(clipTitle, videoTitle);
        }
    }

    private generateFallbackTags(clipTitle: string, videoTitle: string): { tags: string[]; engagementPhrases: string[] } {
        const words = `${clipTitle} ${videoTitle}`.toLowerCase()
            .replace(/[^a-záàâãéèêíïóôõöúçñ0-9\s]/gi, '')
            .split(/\s+/)
            .filter(w => w.length > 2);

        const uniqueWords = [...new Set(words)];
        const tags = [
            ...uniqueWords.slice(0, 10),
            'clipes',
            'melhores momentos',
            'shorts',
            'viral',
            'clip',
        ];

        return {
            tags,
            engagementPhrases: [
                `Olha esse final 😂`,
                `Ninguém esperava isso 🔥`,
                `Momento épico! 🎬`,
            ],
        };
    }

    private buildFinalDescription(
        userDescription: string,
        tags: string[],
        engagementPhrases: string[],
    ): string {
        const parts: string[] = [];

        // Descrição original do usuário
        if (userDescription && userDescription.trim()) {
            parts.push(userDescription.trim());
        }

        // Frases de engajamento
        if (engagementPhrases.length > 0) {
            parts.push('');
            parts.push(engagementPhrases.join('\n'));
        }

        // Tags
        if (tags.length > 0) {
            parts.push('');
            parts.push('TAG:');
            parts.push(tags.join('\n'));
        }

        return parts.join('\n');
    }
}

