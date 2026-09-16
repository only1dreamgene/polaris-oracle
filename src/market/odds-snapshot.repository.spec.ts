import { ConfigService } from '@nestjs/config';
import { OddsSnapshotRepository } from './odds-snapshot.repository';

function makeConfig() {
  return { get: () => './data/markets.db' } as unknown as ConfigService;
}

describe('OddsSnapshotRepository', () => {
  it('closestBefore returns the most recent snapshot at or before the requested time', () => {
    const repo = new OddsSnapshotRepository(':memory:', makeConfig());
    repo.record('C1', 5000, 5000, 1000);
    repo.record('C1', 6000, 4000, 2000);
    repo.record('C1', 7000, 3000, 3000);

    expect(repo.closestBefore('C1', 2500)).toMatchObject({ yesBps: 6000, noBps: 4000, capturedAt: 2000 });
    // Exact match on capturedAt is inclusive ("at or before").
    expect(repo.closestBefore('C1', 2000)).toMatchObject({ yesBps: 6000, noBps: 4000 });
  });

  it('returns undefined when no snapshot exists that far back yet', () => {
    const repo = new OddsSnapshotRepository(':memory:', makeConfig());
    repo.record('C1', 5000, 5000, 5000);

    expect(repo.closestBefore('C1', 1000)).toBeUndefined();
  });

  it('keeps different markets independent', () => {
    const repo = new OddsSnapshotRepository(':memory:', makeConfig());
    repo.record('C1', 5000, 5000, 1000);
    repo.record('C2', 9000, 1000, 1000);

    expect(repo.closestBefore('C1', 2000)).toMatchObject({ yesBps: 5000 });
    expect(repo.closestBefore('C2', 2000)).toMatchObject({ yesBps: 9000 });
  });

  it('pruneOlderThan deletes only snapshots before the cutoff', () => {
    const repo = new OddsSnapshotRepository(':memory:', makeConfig());
    repo.record('C1', 1000, 9000, 1000);
    repo.record('C1', 2000, 8000, 5000);

    repo.pruneOlderThan(3000);

    expect(repo.closestBefore('C1', 1000)).toBeUndefined();
    expect(repo.closestBefore('C1', 5000)).toMatchObject({ yesBps: 2000, capturedAt: 5000 });
  });
});
