import { Controller, Get, Param, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Powers the frontend's live ticker via Pyth's Hermes HTTP endpoint —
 * separate from the Lazer WebSocket feed used for settlement. Hermes is a
 * plain read of the current published price, no signature verification
 * needed here since nothing downstream trusts this for settlement.
 *
 * Note: Hermes feed IDs (32-byte hex identifiers from Pyth's public price
 * feed registry) are a *different* ID scheme than Pyth Lazer's small
 * integer feed IDs used by `XLM_USD_FEED_ID` for settlement — this endpoint
 * just forwards whatever `feedId` it's given, so the frontend must be
 * configured with XLM/USD's actual Hermes feed ID (looked up from Pyth's
 * registry) for the ticker to show real data. Not fabricated here.
 */
@Controller('prices')
export class PriceController {
  constructor(private readonly config: ConfigService) {}

  @Get(':feedId')
  async get(@Param('feedId') feedId: string) {
    const hermesUrl = this.config.get<string>('pythHermesUrl');
    const res = await fetch(`${hermesUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}`);
    if (!res.ok) {
      throw new ServiceUnavailableException(`Hermes price lookup failed: ${res.status}`);
    }
    return res.json();
  }
}
