import { Test, TestingModule } from '@nestjs/testing';
import { TextReviewController } from './text-review.controller';

describe('TextReviewController', () => {
  let controller: TextReviewController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TextReviewController],
    }).compile();

    controller = module.get<TextReviewController>(TextReviewController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
