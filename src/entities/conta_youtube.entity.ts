import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('contas_youtube')
export class ContaYoutube {
    @PrimaryColumn('uuid')
    id: string;

    @Column({ name: 'usuario_id' })
    usuario_id: string;

    @Column({ name: 'id_canal' })
    id_canal: string;

    @Column({ name: 'nome_canal' })
    nome_canal: string;

    @Column({ name: 'miniatura_canal' })
    miniatura_canal: string;

    @Column({ name: 'access_token' })
    access_token: string;

    @Column({ name: 'refresh_token' })
    refresh_token: string;

    @Column({ type: 'bigint', name: 'token_expiracao' })
    token_expiracao: number;

    @CreateDateColumn()
    criado_em: Date;

    @UpdateDateColumn()
    atualizado_em: Date;
}
