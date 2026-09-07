import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Gates admin-only routes behind a shared `x-admin-key` header, compared
 * with a constant-time comparison to avoid a timing side-channel.
 *
 * Fails closed: if ADMIN_API_KEY is unset (misconfiguration), every admin
 * call is rejected rather than silently accepted.
 *
 * Throws `UnauthorizedException` (401) explicitly rather than returning
 * `false` — Nest's default for a bare `false` from `canActivate` is a 403
 * (Forbidden), which reads as "you're blocked regardless of credentials,"
 * not "this key is invalid." The admin dashboard's key-entry gate probes
 * this guard to decide whether to show the dashboard or a re-enter-key
 * screen, and needs the semantically correct status code to do that.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('adminApiKey');
    if (!expected) {
      throw new UnauthorizedException('admin API is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-admin-key'];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException('x-admin-key header is required');
    }

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw new UnauthorizedException('invalid admin key');
    }
    return true;
  }
}
