import { Module } from '@nestjs/common';
import { TextReviewService } from './text-review.service';
import { TextReviewController } from './text-review.controller';

@Module({
  providers: [TextReviewService],
  controllers: [TextReviewController]
})
export class TextReviewModule {}
