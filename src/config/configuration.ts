export interface AppConfig {
  port: number;
  oracleSecretKey: string;
  adminApiKey: string;
  pythLazerToken: string | undefined;
  pythLazerWsUrl: string;
  pythHermesUrl: string;
  corsOrigins: string[];
  stellarRpcUrl: string;
  stellarNetworkPassphrase: string;
  stellarNetwork: string;
  marketWasmHash: string | undefined;
  lazerContract: string | undefined;
  nativeXlmSac: string | undefined;
  smartWalletFactoryContract: string | undefined;
  smartWalletWasmHash: string | undefined;
  treasuryAddress: string | undefined;
  xlmUsdFeedId: number;
  marketsDbFile: string;
  friendbotUrl: string;
  faucetAmountStroops: string;
  faucetMaxPerHour: number;
  settleFreshnessWindowSecs: number;
  emailWalletEncKeyHex: string;
  sessionJwtSecret: string;
  sessionTtlSecs: number;
  emailProvider: string;
  resendApiKey: string | undefined;
  emailFrom: string;
  emailCodeTtlSecs: number;
  emailCodeMaxAttempts: number;
  emailCodeResendCooldownSecs: number;
  /** Only used to fill in a WebAuthn-shaped `client_data_json`/`rpIdHash` for custodial signatures — never validated on-chain (see `email-wallet-signer.ts`), so these don't need to match the frontend exactly. */
  emailWalletRpId: string;
  emailWalletOrigin: string;
}

import { randomBytes } from 'node:crypto';

/**
 * Dev-only fallback so the process can boot without every secret set —
 * generated fresh each boot, which means any data encrypted/signed with it
 * (custodial private keys, session tokens) becomes unrecoverable/invalid
 * across a restart. Loud on purpose: this must never be what production
 * actually runs on.
 */
function devFallbackSecret(envVar: string, byteLength: number): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  // eslint-disable-next-line no-console
  console.warn(
    `[config] ${envVar} not set — generating a random one for this process only. ` +
      `Custodial email wallets will be unrecoverable after a restart until this is set. Do not run production like this.`,
  );
  return randomBytes(byteLength).toString('hex');
}

export default (): AppConfig => ({
  port: Number(process.env.PORT ?? 3000),
  oracleSecretKey: process.env.ORACLE_SECRET_KEY ?? '',
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  pythLazerToken: process.env.PYTH_LAZER_TOKEN,
  pythLazerWsUrl: process.env.PYTH_LAZER_WS_URL ?? 'wss://pyth-lazer.dourolabs.app/v1/stream',
  pythHermesUrl: process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  stellarRpcUrl: process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  stellarNetworkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  stellarNetwork: process.env.STELLAR_NETWORK ?? 'testnet',
  marketWasmHash: process.env.MARKET_WASM_HASH,
  lazerContract: process.env.LAZER_CONTRACT,
  nativeXlmSac: process.env.NATIVE_XLM_SAC,
  smartWalletFactoryContract: process.env.SMART_WALLET_FACTORY_CONTRACT,
  smartWalletWasmHash: process.env.SMART_WALLET_WASM_HASH,
  treasuryAddress: process.env.TREASURY_ADDRESS,
  // Placeholder testnet feed id — production must use Pyth's real
  // registered Lazer feed id for XLM/USD (see contracts README).
  xlmUsdFeedId: Number(process.env.XLM_USD_FEED_ID ?? 100),
  marketsDbFile: process.env.MARKETS_DB_FILE ?? './data/markets.db',
  friendbotUrl: process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
  faucetAmountStroops: process.env.FAUCET_AMOUNT_STROOPS ?? '5000000000', // 500 XLM
  faucetMaxPerHour: Number(process.env.FAUCET_MAX_PER_HOUR ?? 3),
  settleFreshnessWindowSecs: Number(process.env.SETTLE_FRESHNESS_WINDOW_SECS ?? 300),
  // 32 bytes hex = AES-256-GCM key, encrypting custodial private keys at rest.
  emailWalletEncKeyHex: devFallbackSecret('EMAIL_WALLET_ENC_KEY', 32),
  sessionJwtSecret: devFallbackSecret('SESSION_JWT_SECRET', 32),
  sessionTtlSecs: Number(process.env.SESSION_TTL_SECS ?? 60 * 60 * 24 * 30), // 30 days
  // 'console' (default, logs the code — no real delivery) or 'resend'.
  emailProvider: process.env.EMAIL_PROVIDER ?? 'console',
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM ?? 'Polaris <login@polaris.app>',
  emailCodeTtlSecs: Number(process.env.EMAIL_CODE_TTL_SECS ?? 600), // 10 minutes
  emailCodeMaxAttempts: Number(process.env.EMAIL_CODE_MAX_ATTEMPTS ?? 5),
  emailCodeResendCooldownSecs: Number(process.env.EMAIL_CODE_RESEND_COOLDOWN_SECS ?? 60),
  emailWalletRpId: process.env.EMAIL_WALLET_RP_ID ?? 'localhost',
  emailWalletOrigin: process.env.EMAIL_WALLET_ORIGIN ?? 'http://localhost:3000',
});
