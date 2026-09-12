import { IsInt, IsNumberString, Min } from 'class-validator';

/** No `strikePriceCents`/`expiry`/`gracePeriodSecs` — none exist on `polaris-perpetual`. See `CreateMarketDto` for the fee/liquidity fields' shared meaning. */
export class CreatePerpetualDto {
  @IsInt()
  @Min(0)
  baseFeeBps!: number;

  @IsInt()
  @Min(0)
  minFeeBps!: number;

  @IsNumberString()
  initialLiquidityStroops!: string;
}
