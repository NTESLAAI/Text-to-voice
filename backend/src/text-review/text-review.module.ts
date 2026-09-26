import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TextReviewService } from './text-review.service';
import { TextReviewController } from './text-review.controller';

@Module({
  imports: [PrismaModule],
  providers: [TextReviewService],
  controllers: [TextReviewController],
})
export class TextReviewModule {}
