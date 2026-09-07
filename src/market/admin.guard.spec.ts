import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';

function makeContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function makeConfig(adminApiKey: string | undefined) {
  return { get: () => adminApiKey } as unknown as ConfigService;
}

describe('AdminGuard', () => {
  it('rejects every call when ADMIN_API_KEY is unset (fails closed), with 401 semantics', () => {
    const guard = new AdminGuard(makeConfig(undefined));
    expect(() => guard.canActivate(makeContext({ 'x-admin-key': 'anything' }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects a missing header with 401, not 403', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects a wrong key', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(() => guard.canActivate(makeContext({ 'x-admin-key': 'wrong' }))).toThrow(UnauthorizedException);
  });

  it('rejects a key of different length without throwing a non-Nest error', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(() => guard.canActivate(makeContext({ 'x-admin-key': 'sec' }))).toThrow(UnauthorizedException);
  });

  it('accepts the correct key', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(guard.canActivate(makeContext({ 'x-admin-key': 'secret' }))).toBe(true);
  });
});
