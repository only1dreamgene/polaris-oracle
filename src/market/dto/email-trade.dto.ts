import { IsIn, IsObject, IsString, Length } from 'class-validator';
import { SPONSORABLE_FUNCTIONS } from '../wire-args';

export class EmailTradeDto {
  @IsString()
  @Length(56, 56)
  contractId!: string;

  @IsIn(SPONSORABLE_FUNCTIONS)
  function!: string;

  @IsObject()
  args!: Record<string, string | number>;
}
