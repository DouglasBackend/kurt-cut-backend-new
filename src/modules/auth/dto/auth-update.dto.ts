import { IsEmail, IsString } from 'class-validator';

export class AuthUpdateDto {
  @IsString()
  nome: string;

  @IsEmail()
  email: string;
}
