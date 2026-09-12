import { IsIn, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { SPONSORABLE_FUNCTIONS } from '../wire-args';
import { CONTRACT_KINDS, type ContractKind } from './prepare-auth.dto';

export class EmailTradeDto {
  @IsString()
  @Length(56, 56)
  contractId!: string;

  @IsIn(SPONSORABLE_FUNCTIONS)
  function!: string;

  @IsObject()
  args!: Record<string, string | number>;

  @IsOptional()
  @IsIn(CONTRACT_KINDS)
  contractKind?: ContractKind;
}
