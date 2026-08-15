import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

/**
 * Decouples `MarketService` from `MarketFactoryService` so neither has to
 * construct-inject the other. `MarketFactoryService` already depends on
 * `MarketService` (to call `.watch()` on a newly-created market) — having
 * `MarketService` depend back on `MarketFactoryService` to trigger an
 * auto-rolled successor would be circular DI, and `market.service.spec.ts`
 * constructs `MarketService` directly (no DI container) in several places,
 * which a `forwardRef()` would force a new constructor arg into everywhere.
 * A plain injectable event bus — Node's built-in `EventEmitter`, no new
 * dependency — sidesteps both problems: `MarketService` only ever emits,
 * `MarketFactoryService` only ever listens.
 */
@Injectable()
export class MarketEvents extends EventEmitter {}
