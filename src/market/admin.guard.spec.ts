import { ExecutionContext } from '@nestjs/common';
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
  it('rejects every call when ADMIN_API_KEY is unset (fails closed)', () => {
    const guard = new AdminGuard(makeConfig(undefined));
    expect(guard.canActivate(makeContext({ 'x-admin-key': 'anything' }))).toBe(false);
    expect(guard.canActivate(makeContext({}))).toBe(false);
  });

  it('rejects a missing header', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(guard.canActivate(makeContext({}))).toBe(false);
  });

  it('rejects a wrong key', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(guard.canActivate(makeContext({ 'x-admin-key': 'wrong' }))).toBe(false);
  });

  it('rejects a key of different length without throwing', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(guard.canActivate(makeContext({ 'x-admin-key': 'sec' }))).toBe(false);
  });

  it('accepts the correct key', () => {
    const guard = new AdminGuard(makeConfig('secret'));
    expect(guard.canActivate(makeContext({ 'x-admin-key': 'secret' }))).toBe(true);
  });
});
