import { Test, TestingModule } from '@nestjs/testing';
import { AudioService } from './audio.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AudioService', () => {
  let service: AudioService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AudioService,
        {
          provide: PrismaService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<AudioService>(AudioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
