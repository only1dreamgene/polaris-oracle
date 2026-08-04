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
  protocolFeeBps: number;
  treasuryAddress: string | undefined;
  xlmUsdFeedId: number;
  marketsDbFile: string;
  friendbotUrl: string;
  faucetAmountStroops: string;
  faucetMaxPerHour: number;
  settleFreshnessWindowSecs: number;
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
  protocolFeeBps: Number(process.env.PROTOCOL_FEE_BPS ?? 100),
  treasuryAddress: process.env.TREASURY_ADDRESS,
  // Placeholder testnet feed id — production must use Pyth's real
  // registered Lazer feed id for XLM/USD (see contracts README).
  xlmUsdFeedId: Number(process.env.XLM_USD_FEED_ID ?? 100),
  marketsDbFile: process.env.MARKETS_DB_FILE ?? './data/markets.db',
  friendbotUrl: process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
  faucetAmountStroops: process.env.FAUCET_AMOUNT_STROOPS ?? '5000000000', // 500 XLM
  faucetMaxPerHour: Number(process.env.FAUCET_MAX_PER_HOUR ?? 3),
  settleFreshnessWindowSecs: Number(process.env.SETTLE_FRESHNESS_WINDOW_SECS ?? 300),
});
