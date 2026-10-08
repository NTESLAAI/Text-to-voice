import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { name: string; userId: string }) {
    return this.prisma.project.create({
      data: {
        name: data.name,
        userId: data.userId,
      },
    });
  }
  async getOrCreateForUser(userId: string) {
    const existingProject = await this.prisma.project.findFirst({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    if (existingProject) {
      return existingProject;
    }

    return this.prisma.project.create({
      data: {
        name: 'My Project',
        userId,
      },
    });
  }
  async findAll(userId: string) {
    return this.prisma.project.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: string, userId: string) {
    return this.prisma.project.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        audios: true,
      },
    });
  }
}
