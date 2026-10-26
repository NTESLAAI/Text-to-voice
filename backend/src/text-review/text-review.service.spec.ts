jest.mock('@openrouter/sdk', () => ({
  OpenRouter: jest.fn().mockImplementation(() => ({
    chat: {
      send: jest.fn(),
    },
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { TextReviewService } from './text-review.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TextReviewService', () => {
  let service: TextReviewService;

  beforeEach(async () => {
    process.env.OPENROUTER_API_KEY = 'test-api-key';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TextReviewService,
        {
          provide: PrismaService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<TextReviewService>(TextReviewService);
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
