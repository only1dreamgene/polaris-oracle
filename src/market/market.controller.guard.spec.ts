import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MarketController } from './market.controller';
import { AdminGuard } from './admin.guard';

/**
 * A route handler silently losing its `@UseGuards(AdminGuard)` decorator in
 * a refactor is exactly the kind of regression that won't show up as a
 * failing request in dev (it'll just work, minus the auth check) — assert
 * on the metadata directly so it's a test failure instead.
 */
describe('MarketController — admin routes stay guarded', () => {
  const adminRoutes = ['create', 'runFactory', 'watch', 'settle', 'cancel'] as const;
  const publicRoutes = ['list', 'get', 'state', 'position', 'price', 'fee', 'fundFaucet'] as const;

  it.each(adminRoutes)('%s carries AdminGuard', (method) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, MarketController.prototype[method]) ?? [];
    expect(guards).toContain(AdminGuard);
  });

  it.each(publicRoutes)('%s does not require AdminGuard', (method) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, MarketController.prototype[method]) ?? [];
    expect(guards).not.toContain(AdminGuard);
  });
});
