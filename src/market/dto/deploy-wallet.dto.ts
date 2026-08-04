import { IsString, Matches } from 'class-validator';

export class DeployWalletDto {
  /** 65-byte uncompressed secp256r1 SEC1 public key, hex-encoded (130 hex chars). */
  @IsString()
  @Matches(/^04[0-9a-fA-F]{128}$/, {
    message: 'publicKeyHex must be a 65-byte (130 hex char) uncompressed SEC1 point starting with 04',
  })
  publicKeyHex!: string;
}
