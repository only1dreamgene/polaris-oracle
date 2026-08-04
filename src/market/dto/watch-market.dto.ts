import { IsString, Length } from 'class-validator';

export class WatchMarketDto {
  @IsString()
  @Length(56, 56)
  contractId!: string;
}
