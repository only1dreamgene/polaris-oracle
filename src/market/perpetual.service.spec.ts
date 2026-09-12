import { PerpetualService } from './perpetual.service';
import { PerpetualRepository } from './perpetual.repository';
import type { StellarService } from './stellar.service';
import type { WatchedPerpetual } from './perpetual.types';

// Same "hand-rolled fake, not the real StellarService" rationale as
// market.service.spec.ts — this suite is pure bookkeeping logic and
// shouldn't need @stellar/stellar-sdk or real network calls.
function makeRepo(): PerpetualRepository {
  const store = new Map<string, WatchedPerpetual>();
  return {
    upsert: jest.fn((p: WatchedPerpetual) => store.set(p.contractId, { ...p })),
    getAll: jest.fn(() => [...store.values()]),
    getById: jest.fn((id: string) => store.get(id)),
    onModuleDestroy: jest.fn(),
  } as unknown as PerpetualRepository;
}

function sample(overrides: Partial<WatchedPerpetual> = {}): WatchedPerpetual {
  const now = Date.now();
  return { contractId: 'CPERP1', status: 'watching', createdAt: now, updatedAt: now, ...overrides };
}

describe('PerpetualService', () => {
  it('watch() records a new perpetual as watching', () => {
    const repo = makeRepo();
    const service = new PerpetualService(repo, {} as StellarService);

    const watched = service.watch('CPERP1');

    expect(watched.status).toBe('watching');
    expect(service.get('CPERP1')).toEqual(watched);
    expect(service.list()).toEqual([watched]);
  });

  it('triggerTerminate() calls StellarService.terminatePerpetual and records the tx hash', async () => {
    const repo = makeRepo();
    repo.upsert(sample());
    const stellar = { terminatePerpetual: jest.fn().mockResolvedValue('TERMTX') } as unknown as StellarService;
    const service = new PerpetualService(repo, stellar);

    await service.triggerTerminate('CPERP1');

    expect(stellar.terminatePerpetual).toHaveBeenCalledWith('CPERP1');
    const updated = service.get('CPERP1')!;
    expect(updated.status).toBe('terminated');
    expect(updated.terminateTxHash).toBe('TERMTX');
    expect(updated.lastError).toBeUndefined();
  });

  it('triggerTerminate() records lastError and rethrows on failure, leaving status unchanged', async () => {
    const repo = makeRepo();
    repo.upsert(sample());
    const stellar = {
      terminatePerpetual: jest.fn().mockRejectedValue(new Error('AlreadyFinalized')),
    } as unknown as StellarService;
    const service = new PerpetualService(repo, stellar);

    await expect(service.triggerTerminate('CPERP1')).rejects.toThrow('AlreadyFinalized');

    const updated = service.get('CPERP1')!;
    expect(updated.status).toBe('watching'); // unchanged — the on-chain call never succeeded
    expect(updated.lastError).toBe('AlreadyFinalized');
  });

  it('triggerTerminate() throws for an unknown contract id without calling StellarService', async () => {
    const repo = makeRepo();
    const stellar = { terminatePerpetual: jest.fn() } as unknown as StellarService;
    const service = new PerpetualService(repo, stellar);

    await expect(service.triggerTerminate('CUNKNOWN')).rejects.toThrow('unknown perpetual');
    expect(stellar.terminatePerpetual).not.toHaveBeenCalled();
  });
});
