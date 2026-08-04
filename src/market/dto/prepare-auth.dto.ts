import { IsIn, IsObject, IsString, Length } from 'class-validator';

const SPONSORABLE_FUNCTIONS = ['buy', 'sell', 'split', 'merge', 'transfer', 'redeem'] as const;
export type SponsorableFunction = (typeof SPONSORABLE_FUNCTIONS)[number];

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
}
