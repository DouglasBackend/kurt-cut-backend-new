import { IsEmail, IsString, MinLength } from 'class-validator';

export class AuthRegisterDto {
  @IsString()
  nome: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  confirm_password: string;
}
