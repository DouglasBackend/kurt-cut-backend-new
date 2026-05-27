import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { Projeto } from './projeto.entity';
import { Corte } from './corte.entity';
import { Legenda } from './legenda.entity';

@Entity('videos')
export class Video {
    @PrimaryColumn('uuid')
    id: string;

    @Column({ name: 'projeto_id' })
    projeto_id: string;

    @ManyToOne(() => Projeto, projeto => projeto.videos, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'projeto_id' })
    projeto: Projeto;

    @OneToMany(() => Corte, corte => corte.video)
    cortes: Corte[];

    @OneToMany(() => Legenda, legenda => legenda.video)
    legendas: Legenda[];

    @Column()
    titulo: string;

    @Column({ name: 'tipo_fonte' }) // 'youtube', 'upload'
    tipo_fonte: string;

    @Column({ nullable: true, name: 'url_fonte' })
    url_fonte: string;

    @Column({ nullable: true, name: 'caminho_arquivo' })
    caminho_arquivo: string;

    @Column({ nullable: true, name: 'youtube_id' })
    youtube_id: string;

    @Column({ nullable: true, name: 'miniatura_youtube' })
    miniatura_youtube: string;

    @Column({ nullable: true })
    criador: string;

    @Column({ type: 'bigint', default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
    visualizacoes: number;

    @Column({ type: 'bigint', default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
    curtidas: number;

    @Column({ type: 'bigint', default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
    comentarios: number;

    @Column({ type: 'float', nullable: true })
    duracao: number;

    @Column({ default: 'idle', name: 'status_transcricao' })
    status_transcricao: string;

    @Column({ default: 'idle', name: 'status_analise' })
    status_analise: string;

    @Column({ type: 'jsonb', nullable: true, name: 'preferencias_corte' })
    preferencias_corte: any;

    @Column({ type: 'jsonb', nullable: true, name: 'resultado_analise' })
    resultado_analise: any;

    @Column({ nullable: true, name: 'id_transcricao' })
    id_transcricao: string;

    @Column({ type: 'text', nullable: true, name: 'texto_transcricao' })
    texto_transcricao: string;

    @Column({ type: 'jsonb', nullable: true, name: 'palavras_transcricao' })
    palavras_transcricao: any[];

    @CreateDateColumn()
    criado_em: Date;

    @UpdateDateColumn()
    atualizado_em: Date;
}
