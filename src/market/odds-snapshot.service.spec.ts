import { ConfigService } from '@nestjs/config';
import { OddsSnapshotService } from './odds-snapshot.service';
import type { MarketService } from './market.service';
import type { StellarService } from './stellar.service';
import type { OddsSnapshotRepository } from './odds-snapshot.repository';
import type { WatchedMarket } from './market.types';

function watchedMarket(overrides: Partial<WatchedMarket> = {}): WatchedMarket {
  const now = Date.now();
  return {
    contractId: 'C1',
    strikePriceCents: '1000',
    expiry: Math.floor(now / 1000) + 3600,
    gracePeriodSecs: 3600,
    feedId: 100,
    status: 'watching',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeConfig() {
  return { get: () => 300 } as unknown as ConfigService;
}

describe('OddsSnapshotService.run()', () => {
  it('records a snapshot for every open market, skipping closed ones', async () => {
    const markets = {
      list: jest.fn().mockReturnValue([
        watchedMarket({ contractId: 'C1', status: 'watching' }),
        watchedMarket({ contractId: 'C2', status: 'settled' }),
      ]),
    } as unknown as MarketService;
    const stellar = { getPrice: jest.fn().mockResolvedValue({ yesBps: 6000, noBps: 4000 }) } as unknown as StellarService;
    const snapshots = { record: jest.fn(), pruneOlderThan: jest.fn() } as unknown as OddsSnapshotRepository;

    const svc = new OddsSnapshotService(markets, stellar, snapshots, makeConfig());
    await svc.run();

    expect(stellar.getPrice).toHaveBeenCalledTimes(1);
    expect(stellar.getPrice).toHaveBeenCalledWith('C1');
    expect(snapshots.record).toHaveBeenCalledWith('C1', 6000, 4000);
    expect(snapshots.pruneOlderThan).toHaveBeenCalled();
  });

  it('a failed price read for one market does not stop the rest from being recorded', async () => {
    const markets = {
      list: jest.fn().mockReturnValue([
        watchedMarket({ contractId: 'C1', status: 'watching' }),
        watchedMarket({ contractId: 'C2', status: 'watching' }),
      ]),
    } as unknown as MarketService;
    const stellar = {
      getPrice: jest.fn().mockImplementation(async (id: string) => {
        if (id === 'C1') throw new Error('RPC hiccup');
        return { yesBps: 5000, noBps: 5000 };
      }),
    } as unknown as StellarService;
    const snapshots = { record: jest.fn(), pruneOlderThan: jest.fn() } as unknown as OddsSnapshotRepository;

    const svc = new OddsSnapshotService(markets, stellar, snapshots, makeConfig());
    await svc.run();

    expect(snapshots.record).toHaveBeenCalledTimes(1);
    expect(snapshots.record).toHaveBeenCalledWith('C2', 5000, 5000);
  });
});
