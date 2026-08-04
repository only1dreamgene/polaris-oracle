import { IsString, Length } from 'class-validator';

export class FaucetDto {
  @IsString()
  @Length(56, 56)
  address!: string;
}
