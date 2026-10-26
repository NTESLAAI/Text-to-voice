import { Test, TestingModule } from '@nestjs/testing';
import { AudioController } from './audio.controller';
import { AudioService } from './audio.service';

describe('AudioController', () => {
  let controller: AudioController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AudioController],
      providers: [
        {
          provide: AudioService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<AudioController>(AudioController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
