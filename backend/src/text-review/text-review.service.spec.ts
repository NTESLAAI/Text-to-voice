import { Test, TestingModule } from '@nestjs/testing';
import { TextReviewService } from './text-review.service';

describe('TextReviewService', () => {
  let service: TextReviewService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TextReviewService],
    }).compile();

    service = module.get<TextReviewService>(TextReviewService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
