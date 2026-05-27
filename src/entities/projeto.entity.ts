import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Video } from './video.entity';

@Entity('projetos')
export class Projeto {
    @PrimaryColumn('uuid')
    id: string;

    @Column()
    nome: string;

    @Column({ nullable: true })
    descricao: string;

    @Column({ name: 'usuario_id' })
    usuario_id: string;

    @OneToMany(() => Video, video => video.projeto)
    videos: Video[];

    @CreateDateColumn()
    criado_em: Date;

    @UpdateDateColumn()
    atualizado_em: Date;
}
