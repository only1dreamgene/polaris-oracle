import { BadRequestException } from '@nestjs/common';
import { EmailAuthError } from './email-auth.service';
import { messageOf } from './email-auth.message';

describe('messageOf', () => {
  it('passes through an EmailAuthError message verbatim', () => {
    expect(messageOf(new EmailAuthError('Incorrect code.'))).toBe('Incorrect code.');
  });

  // Regression for: AuthRelayService's diagnostic BadRequestExceptions
  // ("simulation failed: ...", "no authorization entry for ... was
  // recorded ...") were collapsing into a generic "Something went wrong"
  // because messageOf only special-cased EmailAuthError. That made a real,
  // safe-to-show failure (e.g. a zero-balance wallet's buy simulation
  // failing) undebuggable from the client.
  it('surfaces a BadRequestException string message', () => {
    expect(messageOf(new BadRequestException('simulation failed: insufficient balance'))).toBe(
      'simulation failed: insufficient balance',
    );
  });

  it('surfaces a BadRequestException array message (e.g. from class-validator) joined', () => {
    expect(messageOf(new BadRequestException(['field a is required', 'field b is required']))).toBe(
      'field a is required, field b is required',
    );
  });

  it('falls back to a generic message for a non-HttpException error, to avoid leaking internals', () => {
    expect(messageOf(new Error('ECONNREFUSED 127.0.0.1:5432'))).toBe('Something went wrong. Please try again.');
  });

  it('falls back to a generic message for a non-Error throw', () => {
    expect(messageOf('literally a string')).toBe('Something went wrong. Please try again.');
  });
});
