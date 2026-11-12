import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

import { RegisterDto } from './dto/register.dto/register.dto';
import { LoginDto } from './dto/login.dto/login.dto';
import { PasswordResetMailer } from './password-reset-mailer.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly mailer: PasswordResetMailer,
  ) {}

  async register(data: RegisterDto) {
    try {
      return await this.usersService.create(data);
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const target = error?.meta?.target;
        const fields = Array.isArray(target)
          ? target.join(',')
          : String(target ?? '');

        if (fields.includes('phone')) {
          throw new ConflictException('Số điện thoại đã được đăng ký');
        }

        if (fields.includes('email')) {
          throw new ConflictException('Email đã được đăng ký');
        }

        throw new ConflictException('Email hoặc số điện thoại đã được đăng ký');
      }

      throw error;
    }
  }

  async login(data: LoginDto) {
    const user = await this.usersService.findByIdentifierWithPassword(
      data.identifier,
    );

    if (!user) {
      throw new UnauthorizedException();
    }

    const isPasswordValid = await bcrypt.compare(
      data.password,
      user.password ?? '',
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException();
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      authVersion: user.authVersion,
    });

    return {
      message: 'Đăng nhập thành công',
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async forgotPassword(email: string) {
    const normalizedEmail = email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: {
        email: normalizedEmail,
      },
      select: {
        id: true,
      },
    });

    // Không tiết lộ email có tồn tại trong hệ thống hay không.
    if (!user) {
      return {
        message:
          'Nếu email tồn tại trong hệ thống, yêu cầu đặt lại mật khẩu đã được tạo.',
      };
    }

    // Token cũ chưa sử dụng sẽ không còn hiệu lực.
    await this.prisma.passwordResetToken.deleteMany({
      where: {
        userId: user.id,
        usedAt: null,
      },
    });

    const rawToken = randomBytes(32).toString('hex');

    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    try {
      await this.mailer.sendReset(normalizedEmail, rawToken);
    } catch {
      this.logger.warn('PASSWORD_RESET_MAIL_FAILED');
    }
    return {
      message:
        'Nếu email tồn tại trong hệ thống, yêu cầu đặt lại mật khẩu đã được tạo.',
    };
  }
  async resetPassword(token: string, newPassword: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: {
        tokenHash,
      },
    });

    if (!resetToken) {
      throw new BadRequestException('Token đặt lại mật khẩu không hợp lệ.');
    }

    if (resetToken.usedAt) {
      throw new BadRequestException('Token đặt lại mật khẩu đã được sử dụng.');
    }

    if (resetToken.expiresAt <= new Date()) {
      throw new BadRequestException('Token đặt lại mật khẩu đã hết hạn.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: {
          id: resetToken.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new BadRequestException('RESET_TOKEN_INVALID');
      await tx.user.update({
        where: { id: resetToken.userId },
        data: { password: hashedPassword, authVersion: { increment: 1 } },
      });
      await tx.passwordResetToken.deleteMany({
        where: { userId: resetToken.userId, id: { not: resetToken.id } },
      });
    });

    return {
      message: 'Đặt lại mật khẩu thành công.',
    };
  }
}
