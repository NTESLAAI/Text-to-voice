import {
  Body,
  Controller,
  Post,
} from '@nestjs/common';

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
  async reviewText(
    @Body() body: ReviewTextDto,
  ) {
    return this.textReviewService.reviewText(
      body.text,
    );
  }
}