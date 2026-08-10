import { HttpException } from '@nestjs/common';
import { EmailAuthError } from './email-auth.service';

/**
 * Picks the string to hand back to the client for an error caught in
 * `EmailAuthController`. `EmailAuthError` messages are always safe (they're
 * written for the end user). `HttpException`s thrown deeper in the stack —
 * chiefly `AuthRelayService`'s `BadRequestException`s ("simulation failed:
 * ...", "no authorization entry for ... was recorded for ...") — are also
 * deliberately-written, safe-to-show diagnostic text, not leaked internals,
 * so they're worth surfacing too: without this, every relay failure
 * collapsed into an undebuggable generic string (e.g. a brand-new,
 * zero-balance wallet's first trade failing with nothing but "Something
 * went wrong"). Anything else (a raw `Error`, a DB failure, ...) still
 * falls back to the generic message — those aren't written to be shown.
 */
export function messageOf(err: unknown): string {
  if (err instanceof EmailAuthError) return err.message;
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (typeof body === 'string') return body;
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message;
      return Array.isArray(message) ? message.join(', ') : String(message);
    }
  }
  return 'Something went wrong. Please try again.';
}
