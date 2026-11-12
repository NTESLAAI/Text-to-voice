import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { TextReviewService } from './text-review.service';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReviewTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text!: string;
}

@Controller('text-review')
export class TextReviewController {
  constructor(private readonly textReviewService: TextReviewService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async reviewText(
    @Body() body: ReviewTextDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.textReviewService.reviewText(body.text, req.user.userId);
  }
}
