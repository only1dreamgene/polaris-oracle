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

  /** Protocol swap fee, basis points (<= 1000 = 10%). */
  @IsInt()
  @Min(0)
  feeBps!: number;

  /** Collateral pulled from the deployer to seed the AMM pool, in stroops. */
  @IsNumberString()
  initialLiquidityStroops!: string;
}
