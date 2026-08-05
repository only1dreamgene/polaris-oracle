export type TrackedStatus = 'watching' | 'settling' | 'settled' | 'cancelling' | 'cancelled' | 'pending';

export interface WatchedMarket {
  contractId: string;
  strikePriceCents: string;
  expiry: number; // unix seconds
  gracePeriodSecs: number;
  feedId: number;
  status: TrackedStatus;
  lastError?: string;
  settleTxHash?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Normalized, REST-friendly view of the on-chain `Market` struct —
 * camelCase, bigints stringified, the `MarketStatus` union unwrapped to a
 * plain string. `contract.Spec` (see `contracts.ts`) decodes structs and
 * enums to their *raw* shape instead — exact Rust field names (snake_case)
 * and `{ tag: 'Open' }`-style union objects — so `StellarService.
 * getMarketState` does this translation explicitly rather than casting the
 * raw decode result and hoping the shapes line up. See `RawOnChainMarket`
 * there for the shape this is built from.
 */
export interface OnChainMarket {
  admin: string;
  collateral: string;
  strikePrice: string;
  expiry: string;
  gracePeriod: string;
  lazerContract: string;
  feedId: number;
  baseFeeBps: number;
  minFeeBps: number;
  treasury: string;
  status: 'Open' | 'ResolvedYes' | 'ResolvedNo' | 'Cancelled';
  finalPrice: string;
  poolYes: string;
  poolNo: string;
  totalSupply: string;
  initialLiquidity: string;
}
