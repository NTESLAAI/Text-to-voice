import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { TextReviewService } from './text-review.service';

interface ReviewTextDto {
  text: string;
}

@Controller('text-review')
export class TextReviewController {
  constructor(
    private readonly textReviewService: TextReviewService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async reviewText(
    @Body() body: ReviewTextDto,
    @Req() req: any,
  ) {
    return this.textReviewService.reviewText(
      body.text,
      req.user.userId,
    );
  }
}
