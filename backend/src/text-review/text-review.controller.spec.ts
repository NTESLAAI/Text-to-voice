import { Test, TestingModule } from '@nestjs/testing';
import { TextReviewController } from './text-review.controller';
import { TextReviewService } from './text-review.service';

describe('TextReviewController', () => {
  let controller: TextReviewController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TextReviewController],
      providers: [
        {
          provide: TextReviewService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<TextReviewController>(TextReviewController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
