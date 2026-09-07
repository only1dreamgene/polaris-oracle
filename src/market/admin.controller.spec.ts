import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

/**
 * Same regression-shape as `market.controller.guard.spec.ts` — a
 * class-level `@UseGuards(AdminGuard)` silently dropped in a refactor
 * wouldn't show up as a failing request in dev, just an unauthenticated
 * dashboard API. Asserted on the class itself since the guard here is
 * applied once at the controller level, not per-method.
 */
describe('AdminController — every route stays admin-guarded', () => {
  it('carries AdminGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController) ?? [];
    expect(guards).toContain(AdminGuard);
  });
});
