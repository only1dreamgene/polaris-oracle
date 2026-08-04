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

export interface OnChainMarket {
  admin: string;
  collateral: string;
  strikePrice: string;
  expiry: string;
  gracePeriod: string;
  lazerContract: string;
  feedId: number;
  feeBps: number;
  treasury: string;
  status: 'Open' | 'ResolvedYes' | 'ResolvedNo' | 'Cancelled';
  finalPrice: string;
  poolYes: string;
  poolNo: string;
  totalSupply: string;
}
