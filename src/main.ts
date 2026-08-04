import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length > 0 ? origins : true,
  });

  const port = Number(process.env.PORT ?? 3000);
  // Fly.io's proxy reaches machines over private IPv6 — an IPv4-only bind
  // ('0.0.0.0' or omitted) is unreachable despite the process reporting
  // "started". Bind the wildcard IPv6 address instead.
  await app.listen(port, '::');
  // eslint-disable-next-line no-console
  console.log(`polaris-oracle listening on [::]:${port}`);
}

bootstrap();
