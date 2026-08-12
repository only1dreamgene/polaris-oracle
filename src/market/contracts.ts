import { contract } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WASM binaries + parsed specs for the contracts this backend talks to.
 *
 * Loaded from `wasm/*.wasm` at the repo root (copied from `polaris-contracts`'
 * build output — see that repo's README for how to regenerate them). Using
 * `contract.Spec` (parsed straight from each binary's embedded XDR spec)
 * means argument/return encoding for our custom types (the `Prediction`
 * enum, the `Market` struct) comes from the actual compiled contract, not
 * from us hand-guessing the wire format.
 */
function loadWasm(name: string): Buffer {
  return readFileSync(join(process.cwd(), 'wasm', name));
}

export const MARKET_WASM = loadWasm('polaris_market.wasm');
export const SMART_WALLET_FACTORY_WASM = loadWasm('polaris_smart_wallet_factory.wasm');
export const SMART_WALLET_WASM = loadWasm('polaris_smart_wallet.wasm');
export const VAULT_WASM = loadWasm('polaris_vault.wasm');

export const marketSpec = contract.Spec.fromWasm(MARKET_WASM);
export const factorySpec = contract.Spec.fromWasm(SMART_WALLET_FACTORY_WASM);
export const smartWalletSpec = contract.Spec.fromWasm(SMART_WALLET_WASM);
export const vaultSpec = contract.Spec.fromWasm(VAULT_WASM);
