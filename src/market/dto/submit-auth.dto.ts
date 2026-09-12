import { IsIn, IsInt, IsObject, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CONTRACT_KINDS, type ContractKind, type SponsorableFunction } from './prepare-auth.dto';

const SPONSORABLE_FUNCTIONS = ['buy', 'sell', 'split', 'merge', 'transfer', 'redeem'] as const;

class WebAuthnAssertionDto {
  @IsString()
  authenticatorDataHex!: string;

  @IsString()
  clientDataJsonBase64!: string;

  @IsString()
  signatureHex!: string;
}

export class SubmitAuthDto {
  @IsString()
  entryXdr!: string;

  @IsInt()
  validUntilLedgerSeq!: number;

  @IsString()
  @Length(56, 56)
  contractId!: string;

  @IsIn(SPONSORABLE_FUNCTIONS)
  function!: SponsorableFunction;

  @IsObject()
  args!: Record<string, string | number>;

  @ValidateNested()
  @Type(() => WebAuthnAssertionDto)
  assertion!: WebAuthnAssertionDto;

  @IsOptional()
  @IsIn(CONTRACT_KINDS)
  contractKind?: ContractKind;
}
