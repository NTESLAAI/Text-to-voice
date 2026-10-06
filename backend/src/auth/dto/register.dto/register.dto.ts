import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'hasEmailOrPhone', async: false })
class HasEmailOrPhone implements ValidatorConstraintInterface {
  validate(_value: unknown, args: any): boolean {
    const data = args.object as RegisterDto;
    return Boolean(data.email?.trim() || data.phone?.trim());
  }

  defaultMessage(): string {
    return 'Vui lòng nhập email hoặc số điện thoại.';
  }
}

export class RegisterDto {
  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ.' })
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, {
    message:
      'Số điện thoại phải có từ 8 đến 15 chữ số, có thể bắt đầu bằng dấu +.',
  })
  phone?: string;

  @IsString()
  @MinLength(6)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message:
      'Mật khẩu phải có ít nhất 6 ký tự, 1 chữ hoa, 1 chữ thường và 1 chữ số.',
  })
  @Validate(HasEmailOrPhone)
  password!: string;

  @IsOptional()
  @IsString()
  name?: string;
}
