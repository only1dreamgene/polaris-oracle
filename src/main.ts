import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { resolveCorsOrigins } from './cors-origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const origins = resolveCorsOrigins(process.env.CORS_ORIGINS);
  if (origins.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[cors] CORS_ORIGINS not set — rejecting all cross-origin requests. ' +
        'Do not fall back to reflecting the request Origin here: this API now ' +
        'sets a session cookie (polaris_session) and `credentials: true` is ' +
        'required for the browser to send it, so `origin: true` + `credentials: ' +
        'true` would let any website on the internet ride a signed-in user\'s ' +
        'session (read it and trigger sponsored trades, e.g. transfer) — CORS ' +
        'is the only thing standing between a stranger\'s browser and that ' +
        'cookie. Fail closed instead, the way AdminGuard fails closed on a ' +
        'missing ADMIN_API_KEY.',
    );
  }
  app.enableCors({
    // `credentials: true` is what lets the browser actually send the
    // `polaris_session` cookie cross-origin (frontend :3000 -> backend
    // :3001) — without it, fetch's `credentials: 'include'` on the
    // frontend has nothing to work with. Because credentials are on, origin
    // must be an explicit allowlist, never `true`/`*` — `cors` reflects the
    // request's Origin verbatim when `origin: true`, which combined with
    // `credentials: true` lets any site ride the session cookie. An unset
    // CORS_ORIGINS fails closed (empty allowlist) rather than open.
    origin: origins,
    credentials: true,
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
