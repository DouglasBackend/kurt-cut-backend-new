import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Video } from './video.entity';

@Entity('cortes')
export class Corte {
    @PrimaryColumn('uuid')
    id: string;

    @Column({ name: 'video_id' })
    video_id: string;

    @ManyToOne(() => Video, video => video.cortes, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'video_id' })
    video: Video;

    @Column()
    titulo: string;

    @Column({ type: 'text', nullable: true })
    descricao: string;

    @Column({ type: 'float' })
    tempo_inicio: number;

    @Column({ type: 'float' })
    tempo_fim: number;

    @Column({ type: 'float' })
    duracao: number;

    @Column({ type: 'int', default: 0 })
    pontuacao_viral: number;

    @Column({ type: 'text', nullable: true })
    justificativa: string;

    @Column({ default: 'idle' })
    status: string; // 'idle', 'processing', 'completed', 'error'

    @Column({ nullable: true, name: 'caminho_arquivo' })
    caminho_arquivo: string;

    @Column({ nullable: true, name: 'miniatura_caminho' })
    miniatura_caminho: string;

    @Column({ type: 'jsonb', nullable: true, name: 'dados_legenda' })
    dados_legenda: any;

    @Column({ default: '9:16', name: 'proporcao_tela' })
    proporcao_tela: string;

    @Column({ type: 'int', default: 0, name: 'export_count' })
    export_count: number;

    @CreateDateColumn()
    criado_em: Date;

    @UpdateDateColumn()
    atualizado_em: Date;
}
