import { Module } from '@nestjs/common';
import { AiWorkloadModule } from '../ai/ai-workload.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TextReviewService } from './text-review.service';
import { TextReviewController } from './text-review.controller';

@Module({
  imports: [PrismaModule, AiWorkloadModule],
  providers: [TextReviewService],
  controllers: [TextReviewController],
})
export class TextReviewModule {}
