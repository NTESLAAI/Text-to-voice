import { Module } from '@nestjs/common';
import { AiWorkloadService } from './ai-workload.service';

@Module({ providers: [AiWorkloadService], exports: [AiWorkloadService] })
export class AiWorkloadModule {}
