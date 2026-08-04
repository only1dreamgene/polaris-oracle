import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Gates admin-only routes behind a shared `x-admin-key` header, compared
 * with a constant-time comparison to avoid a timing side-channel.
 *
 * Fails closed: if ADMIN_API_KEY is unset (misconfiguration), every admin
 * call is rejected rather than silently accepted.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('adminApiKey');
    if (!expected) {
      return false;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-admin-key'];
    if (typeof provided !== 'string' || provided.length === 0) {
      return false;
    }

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, providedBuf);
  }
}
