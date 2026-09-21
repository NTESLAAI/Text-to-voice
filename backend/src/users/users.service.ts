import * as bcrypt from 'bcrypt';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { email: string; password?: string; name?: string }) {
    const hashedPassword = data.password
      ? await bcrypt.hash(data.password, 12)
      : undefined;

    return this.prisma.$transaction(async (tx) => {
      const freePlan = await tx.plan.findUnique({
        where: {
          code: 'FREE',
        },
      });

      if (!freePlan || !freePlan.isActive) {
        throw new Error('FREE plan is not available');
      }

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + freePlan.durationDays);

      const user = await tx.user.create({
        data: {
          email: data.email.trim().toLowerCase(),
          password: hashedPassword,
          name: data.name,
        },
        select: publicUserSelect,
      });

      await tx.subscription.create({
        data: {
          userId: user.id,
          planId: freePlan.id,
          startedAt: now,
          expiresAt,
          status: 'ACTIVE',
          characterLimit: freePlan.characterLimit,
          rolloverCharacters: 0,
          pricePaid: 0,
          currency: freePlan.currency,
        },
      });

      return user;
    });
  }

  async findByEmailWithPassword(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
      },
    });
  }
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        password: true,
      },
    });

    if (!user || !user.password) {
      throw new Error('Không thể đổi mật khẩu cho tài khoản này');
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!isCurrentPasswordValid) {
      throw new BadRequestException('Mật khẩu hiện tại không chính xác');
    }
    const isSamePassword = await bcrypt.compare(newPassword, user.password);

    if (isSamePassword) {
      throw new BadRequestException('Mật khẩu mới phải khác mật khẩu hiện tại');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
      },
    });

    return {
      message: 'Đổi mật khẩu thành công',
    };
  }

  async findAll() {
    return this.prisma.user.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      select: publicUserSelect,
    });
  }

  async findOne(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
  }
}
