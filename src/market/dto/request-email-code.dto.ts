import { IsEmail } from 'class-validator';

export class RequestEmailCodeDto {
  @IsEmail()
  email!: string;
}
