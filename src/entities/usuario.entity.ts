import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('usuarios')
export class Usuario {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    email: string;

    @Column()
    senha_hash: string;

    @Column()
    nome: string;

    @Column({ default: 'active' })
    status: string;

    @Column({ type: 'float', default: 50 })
    creditos_disponiveis: number;

    @Column({ default: 'free' })
    plano: string;

    @Column({ type: 'varchar', nullable: true })
    stripe_customer_id: string | null;

    @Column({ type: 'varchar', nullable: true })
    stripe_subscription_id: string | null;

    @Column({ type: 'timestamp', nullable: true })
    plano_expira_em: Date | null;

    @CreateDateColumn()
    criado_em: Date;

    @UpdateDateColumn()
    atualizado_em: Date;
}
