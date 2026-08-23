import * as bcrypt from 'bcrypt';
import { Injectable } from '@nestjs/common';
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

  async create(data: {
  email: string;
  password?: string;
  name?: string;
}) {
  const hashedPassword = data.password
    ? await bcrypt.hash(data.password, 12)
    : undefined;

  return this.prisma.user.create({
    data: {
      email: data.email,
      password: hashedPassword,
      name: data.name,
    },
    select: publicUserSelect,
  });
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
