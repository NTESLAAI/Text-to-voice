import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { TtsModule } from './tts/tts.module';
import { AudioModule } from './audio/audio.module';
import { TextReviewModule } from './text-review/text-review.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    UsersModule,
    ProjectsModule,
    TtsModule,
    AudioModule,
    TextReviewModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}