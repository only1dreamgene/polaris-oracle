import { IsInt, IsNumberString, IsPositive, Min } from 'class-validator';

export class CreateMarketDto {
  /** Strike price in whole US cents, e.g. 15000000 = $150,000.00. */
  @IsNumberString()
  strikePriceCents!: string;

  /** Unix seconds. Must be in the future. */
  @IsInt()
  @IsPositive()
  expiry!: number;

  /** Seconds after expiry before permissionless cancel/refund opens. */
  @IsInt()
  @Min(60)
  gracePeriodSecs!: number;

  /**
   * Swap fee curve, basis points (<= 1000 = 10% each). The contract charges
   * `baseFeeBps` on a fresh market, decaying toward `minFeeBps` as pool
   * volume grows — see the contracts repo's "Cost-driven fee curve" section.
   */
  @IsInt()
  @Min(0)
  baseFeeBps!: number;

  @IsInt()
  @Min(0)
  minFeeBps!: number;

  /** Collateral pulled from the oracle keypair to seed the AMM pool, in stroops. */
  @IsNumberString()
  initialLiquidityStroops!: string;
}
