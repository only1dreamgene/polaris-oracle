/**
 * Much smaller than `WatchedMarket` — a perpetual has no strike price, no
 * expiry, no `feed_id`, no settlement, so none of `MarketService`'s
 * timer/scheduling fields (`settleTxHash`, grace-period math) apply. See
 * `polaris-contracts/README.md`'s "The perpetual contract" for why: there
 * is no forced terminal settlement under normal operation, so there's
 * nothing here to arm a timer against.
 */
export type WatchedPerpetualStatus = 'watching' | 'terminated';

export interface WatchedPerpetual {
  contractId: string;
  status: WatchedPerpetualStatus;
  lastError?: string;
  terminateTxHash?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Normalized, REST-friendly view of the on-chain `Perpetual` struct — same
 * camelCase/stringified-bigint/unwrapped-status translation `OnChainMarket`
 * does for `Market` (see that interface's doc comment), built from
 * `StellarService.getPerpetualState`'s raw `contract.Spec` decode.
 */
export interface OnChainPerpetual {
  admin: string;
  collateral: string;
  baseFeeBps: number;
  minFeeBps: number;
  treasury: string;
  status: 'Open' | 'Terminated';
  poolYes: string;
  poolNo: string;
  totalSupply: string;
  initialLiquidity: string;
  /** `0`/`0` until a `record_price_checkpoint` call has ever succeeded — purely informational, see the contract's own doc comment. Not wired to a real oracle yet (`price_oracle` is unconfigured for every perpetual this backend deploys — see `PerpetualFactoryService`), so this stays `0` in practice this round. */
  lastPriceCents: string;
  lastPriceAt: string;
}
