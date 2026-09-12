import { IsIn, IsObject, IsOptional, IsString, Length } from 'class-validator';

const SPONSORABLE_FUNCTIONS = ['buy', 'sell', 'split', 'merge', 'transfer', 'redeem'] as const;
export type SponsorableFunction = (typeof SPONSORABLE_FUNCTIONS)[number];

/**
 * Which contract's spec to encode `args` against — `buy`/`sell`/`split`/
 * `merge`/`transfer`/`redeem` are identical function names/shapes on both
 * `polaris-market` and `polaris-perpetual` (see `polaris-contracts/README.md`'s
 * "The perpetual contract"), so the wallet-signing flow itself needs no
 * changes, just the right spec to build call args from. Defaults to
 * `'market'` — every caller before perpetual markets existed omits this.
 */
export const CONTRACT_KINDS = ['market', 'perpetual'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export class PrepareAuthDto {
  @IsString()
  @Length(56, 56)
  walletAddress!: string;

  @IsString()
  @Length(56, 56)
  contractId!: string;

  @IsIn(SPONSORABLE_FUNCTIONS)
  function!: SponsorableFunction;

  @IsObject()
  args!: Record<string, string | number>;

  @IsOptional()
  @IsIn(CONTRACT_KINDS)
  contractKind?: ContractKind;
}
