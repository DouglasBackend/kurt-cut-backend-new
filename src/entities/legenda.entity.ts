import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Video } from './video.entity';

@Entity('legendas')
export class Legenda {
    @PrimaryColumn('uuid')
    id: string;

    @Column({ name: 'video_id' })
    video_id: string;

    @ManyToOne(() => Video, video => video.legendas, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'video_id' })
    video: Video;

    @Column({ default: 'draft' })
    nome: string; // nome do estilo/preset

    @Column()
    formato: string; // 'srt', 'vtt', 'ass'

    @Column()
    idioma: string;

    @Column({ type: 'text', nullable: true })
    conteudo: string; // o SRT gerado, se não salvo em arquivo

    @Column({ nullable: true, name: 'url_arquivo' })
    url_arquivo: string; // se upado em storage

    @Column({ type: 'jsonb', nullable: true })
    estilo: any;

    @Column({ default: false, name: 'esta_embutida' })
    esta_embutida: boolean;

    @CreateDateColumn()
    criado_em: Date;

    @UpdateDateColumn()
    atualizado_em: Date;
}
