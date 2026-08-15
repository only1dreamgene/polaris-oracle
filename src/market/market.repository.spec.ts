import { ConfigService } from '@nestjs/config';
import { MarketRepository } from './market.repository';
import type { WatchedMarket } from './market.types';

function makeConfig() {
  return { get: () => './data/markets.db' } as unknown as ConfigService;
}

function sample(overrides: Partial<WatchedMarket> = {}): WatchedMarket {
  const now = Date.now();
  return {
    contractId: 'CCONTRACT1',
    strikePriceCents: '1500000',
    expiry: 2_000_000,
    gracePeriodSecs: 3600,
    feedId: 100,
    status: 'watching',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('MarketRepository', () => {
  it('round-trips a market through upsert/getById', () => {
    const repo = new MarketRepository(':memory:', makeConfig());
    repo.upsert(sample());
    const found = repo.getById('CCONTRACT1');
    expect(found).toMatchObject({ contractId: 'CCONTRACT1', status: 'watching' });
  });

  it('updates status on conflict instead of duplicating rows', () => {
    const repo = new MarketRepository(':memory:', makeConfig());
    repo.upsert(sample({ status: 'watching' }));
    repo.upsert(sample({ status: 'settled', settleTxHash: 'deadbeef' }));

    expect(repo.getAll()).toHaveLength(1);
    expect(repo.getById('CCONTRACT1')).toMatchObject({
      status: 'settled',
      settleTxHash: 'deadbeef',
    });
  });

  it('getAll returns every tracked market', () => {
    const repo = new MarketRepository(':memory:', makeConfig());
    repo.upsert(sample({ contractId: 'CCONTRACT1' }));
    repo.upsert(sample({ contractId: 'CCONTRACT2' }));
    expect(repo.getAll().map((m) => m.contractId).sort()).toEqual(['CCONTRACT1', 'CCONTRACT2']);
  });

  it('getById returns undefined for an unknown contract', () => {
    const repo = new MarketRepository(':memory:', makeConfig());
    expect(repo.getById('NOPE')).toBeUndefined();
  });

  it('getByFeedId returns only markets for that feed, newest first', () => {
    const repo = new MarketRepository(':memory:', makeConfig());
    repo.upsert(sample({ contractId: 'COLD', feedId: 100, createdAt: 1, updatedAt: 1 }));
    repo.upsert(sample({ contractId: 'CNEW', feedId: 100, createdAt: 2, updatedAt: 2 }));
    repo.upsert(sample({ contractId: 'COTHER', feedId: 200, createdAt: 3, updatedAt: 3 }));

    expect(repo.getByFeedId(100).map((m) => m.contractId)).toEqual(['CNEW', 'COLD']);
    expect(repo.getByFeedId(999)).toEqual([]);
  });
});
