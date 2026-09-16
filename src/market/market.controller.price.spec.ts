import { ConfigService } from '@nestjs/config';
import { MarketController } from './market.controller';
import type { MarketService } from './market.service';
import type { MarketFactoryService } from './market-factory.service';
import type { StellarService } from './stellar.service';
import type { FaucetService } from './faucet.service';
import type { OddsSnapshotRepository } from './odds-snapshot.repository';

function makeController(opts: {
  yesBps: number;
  noBps: number;
  pastSnapshot?: { yesBps: number; noBps: number; capturedAt: number };
}) {
  const stellar = { getPrice: jest.fn().mockResolvedValue({ yesBps: opts.yesBps, noBps: opts.noBps }) } as unknown as StellarService;
  const oddsSnapshots = {
    closestBefore: jest.fn().mockReturnValue(opts.pastSnapshot),
  } as unknown as OddsSnapshotRepository;
  const config = { get: (key: string) => (key === 'oddsChangeWindowSecs' ? 3600 : undefined) } as unknown as ConfigService;

  const controller = new MarketController(
    {} as MarketService,
    {} as MarketFactoryService,
    stellar,
    {} as FaucetService,
    config,
    oddsSnapshots,
  );
  return { controller, oddsSnapshots };
}

describe('MarketController.price — the "Chg" figure the frontend ticker shows', () => {
  it('reports a real yesBpsChange when a snapshot from the configured window exists', async () => {
    const { controller, oddsSnapshots } = makeController({
      yesBps: 6200,
      noBps: 3800,
      pastSnapshot: { yesBps: 5000, noBps: 5000, capturedAt: 1000 },
    });

    const result = await controller.price('C1');

    expect(result).toEqual({ yesBps: 6200, noBps: 3800, yesBpsChange: 1200 });
    expect(oddsSnapshots.closestBefore).toHaveBeenCalledWith('C1', expect.any(Number));
  });

  it('reports null, not 0, when no snapshot exists that far back yet', async () => {
    const { controller } = makeController({ yesBps: 5000, noBps: 5000, pastSnapshot: undefined });

    const result = await controller.price('C1');

    expect(result.yesBpsChange).toBeNull();
  });
});
