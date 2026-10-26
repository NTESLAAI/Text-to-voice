import { Test, TestingModule } from '@nestjs/testing';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';

describe('TtsController', () => {
  let controller: TtsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TtsController],
      providers: [
        {
          provide: TtsService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<TtsController>(TtsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
