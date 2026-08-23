import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AudioService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async findByProject(projectId: string) {
    return this.prisma.audio.findMany({
      where: {
        projectId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: string) {
    const audio = await this.prisma.audio.findUnique({
      where: {
        id,
      },
    });

    if (!audio) {
      throw new NotFoundException('Audio not found');
    }

    return audio;
  }

  async remove(id: string) {
    const audio = await this.findOne(id);
    let fileDeleted = false;
    let fileMissing = false;
    let filePath: string | undefined;

    // Xóa file vật lý nếu có
    if (audio.fileUrl) {
      filePath = join(
        process.cwd(),
        audio.fileUrl.replace(/^\//, ''),
      );

      try {
        await fs.unlink(filePath);
        fileDeleted = true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          fileMissing = true;
        } else {
          throw error;
        }
        // File không tồn tại thì vẫn xóa record database
      }
    }

    // Xóa record database
    try {
      await this.prisma.audio.delete({
        where: {
          id,
        },
      });
    } catch (error) {
      if (fileDeleted || fileMissing) {
        console.error(
          'Failed to delete Audio record after WAV file was removed or missing:',
          { id, filePath, fileDeleted, fileMissing, error },
        );
      }

      throw error;
    }

    return {
      success: true,
      id,
    };
  }
}
