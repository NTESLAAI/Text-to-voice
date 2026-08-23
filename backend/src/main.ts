import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { join } from 'path';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
  AppModule,
);

  const configService = app.get(ConfigService);
  const corsOrigins = (configService.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.enableCors({
  origin: corsOrigins,
});

app.useStaticAssets(
  join(process.cwd(), 'uploads'),
  {
    prefix: '/uploads/',
  },
);

  app.useStaticAssets(
  join(process.cwd(), 'uploads'),
  {
    prefix: '/uploads/',
  },
);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
