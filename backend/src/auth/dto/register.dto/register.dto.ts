import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message:
      'Mật khẩu phải có ít nhất 6 ký tự, 1 chữ hoa, 1 chữ thường và 1 chữ số.',
  })
  password!: string;

  @IsOptional()
  @IsString()
  name?: string;
}
