import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AudioService {
  constructor(private readonly prisma: PrismaService) {}

  async findByProject(projectId: string, userId: string) {
    // Kiểm tra project có thuộc user hiện tại không
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        userId,
      },
      select: {
        id: true,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    await this.removeProjectAudioExceedingLimit(projectId);

    return this.prisma.audio.findMany({
      where: {
        projectId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async removeProjectAudioExceedingLimit(projectId: string, limit = 15) {
    const audiosToRemove = await this.prisma.audio.findMany({
      where: {
        projectId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip: limit,
      select: {
        id: true,
      },
    });

    for (const audio of audiosToRemove) {
      await this.removeInternal(audio.id);
    }
  }

  async findOne(id: string, userId: string) {
    const audio = await this.prisma.audio.findFirst({
      where: {
        id,
        project: {
          userId,
        },
      },
    });

    if (!audio) {
      throw new NotFoundException('Audio not found');
    }

    return audio;
  }

  async getFile(id: string, userId: string) {
    const audio = await this.findOne(id, userId);

    if (!audio.fileUrl) {
      throw new NotFoundException('Audio file not found');
    }

    const filePath = join(process.cwd(), audio.fileUrl.replace(/^\//, ''));

    try {
      const file = await fs.open(filePath, 'r');

      await file.close();

      return new StreamableFile(await fs.readFile(filePath), {
        type: 'audio/wav',
        disposition: 'inline',
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Audio file not found');
      }

      throw error;
    }
  }

  async remove(id: string, userId: string) {
    const audio = await this.findOne(id, userId);

    return this.deleteAudioFileAndRecord(audio);
  }

  /**
   * Xóa nội bộ, dùng cho việc tự động giữ tối đa 15 audio/project.
   * Không cần userId vì hàm này chỉ được gọi sau khi project
   * đã được xác thực thuộc user.
   */
  private async removeInternal(id: string) {
    const audio = await this.prisma.audio.findUnique({
      where: {
        id,
      },
    });

    if (!audio) {
      return;
    }

    return this.deleteAudioFileAndRecord(audio);
  }

  private async deleteAudioFileAndRecord(audio: any) {
    const id = audio.id;

    let fileDeleted = false;
    let fileMissing = false;
    let filePath: string | undefined;

    // Xóa file vật lý nếu có
    if (audio.fileUrl) {
      filePath = join(process.cwd(), audio.fileUrl.replace(/^\//, ''));

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
          {
            id,
            filePath,
            fileDeleted,
            fileMissing,
            error,
          },
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
