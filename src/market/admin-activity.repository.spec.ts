import { ConfigService } from '@nestjs/config';
import { AdminActivityRepository } from './admin-activity.repository';

function makeConfig() {
  return { get: () => './data/markets.db' } as unknown as ConfigService;
}

describe('AdminActivityRepository', () => {
  describe('wallet_actions', () => {
    it('round-trips a recorded action', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      repo.recordWalletAction({
        contractId: 'CMARKET1',
        walletAddress: 'CWALLET1',
        functionName: 'buy',
        collateralAmount: '5000000',
        feeBps: 100,
        txHash: 'TX1',
        source: 'passkey',
      });

      const rows = repo.getRecentWalletActions(10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contract_id: 'CMARKET1',
        wallet_address: 'CWALLET1',
        function: 'buy',
        collateral_amount: '5000000',
        fee_bps: 100,
        tx_hash: 'TX1',
        source: 'passkey',
      });
    });

    it('stores null collateral_amount/fee_bps for actions that never take a fee (e.g. transfer)', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      repo.recordWalletAction({
        contractId: 'CMARKET1',
        walletAddress: 'CWALLET1',
        functionName: 'transfer',
        collateralAmount: undefined,
        feeBps: undefined,
        txHash: 'TX2',
        source: 'email',
      });

      expect(repo.getRecentWalletActions(10)[0]).toMatchObject({ collateral_amount: null, fee_bps: null });
    });

    it('getWalletActionsByFunction filters to exactly the requested functions — the fee-revenue query depends on this excluding split/merge/redeem/transfer', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      const base = { contractId: 'C1', walletAddress: 'W1', collateralAmount: '100', feeBps: 100, txHash: 'T' };
      repo.recordWalletAction({ ...base, functionName: 'buy', source: 'passkey' });
      repo.recordWalletAction({ ...base, functionName: 'sell', source: 'passkey' });
      repo.recordWalletAction({ ...base, functionName: 'redeem', source: 'passkey' });
      repo.recordWalletAction({ ...base, functionName: 'transfer', source: 'passkey' });

      const feePaying = repo.getWalletActionsByFunction(['buy', 'sell']);
      expect(feePaying.map((r) => r.function).sort()).toEqual(['buy', 'sell']);
    });

    it('getDistinctWalletAddresses de-duplicates across multiple actions from the same wallet', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      const base = { contractId: 'C1', collateralAmount: '100', feeBps: 100, functionName: 'buy' as const, source: 'passkey' as const };
      repo.recordWalletAction({ ...base, walletAddress: 'WALLET_A', txHash: 'T1' });
      repo.recordWalletAction({ ...base, walletAddress: 'WALLET_A', txHash: 'T2' });
      repo.recordWalletAction({ ...base, walletAddress: 'WALLET_B', txHash: 'T3' });

      expect(repo.getDistinctWalletAddresses().sort()).toEqual(['WALLET_A', 'WALLET_B']);
    });

    it('countWalletActions counts every row regardless of function', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      repo.recordWalletAction({
        contractId: 'C1',
        walletAddress: 'W1',
        functionName: 'redeem',
        collateralAmount: undefined,
        feeBps: undefined,
        txHash: 'T1',
        source: 'email',
      });
      expect(repo.countWalletActions()).toBe(1);
    });
  });

  describe('vault_flows', () => {
    it('round-trips a recorded withdrawal, newest first', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      repo.recordVaultFlow({ vaultContractId: 'CVAULT', amountStroops: '1000000000', marketContractId: 'CM1', txHash: 'T1' });
      repo.recordVaultFlow({ vaultContractId: 'CVAULT', amountStroops: '2000000000', marketContractId: 'CM2', txHash: 'T2' });

      const rows = repo.getRecentVaultFlows(10);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ market_contract_id: 'CM2', amount_stroops: '2000000000' });
    });
  });

  describe('settlement_checks', () => {
    it('round-trips a passing check with real prices', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      repo.recordSettlementCheck({
        marketContractId: 'CM1',
        lazerPriceCents: 16n,
        hermesPriceCents: 16n,
        divergenceBps: 0,
        outcome: 'ok',
        reason: undefined,
      });

      expect(repo.getRecentSettlementChecks(10)[0]).toMatchObject({
        market_contract_id: 'CM1',
        lazer_price_cents: '16',
        hermes_price_cents: '16',
        divergence_bps: 0,
        outcome: 'ok',
        reason: null,
      });
    });

    it('stores null prices/divergence for a skipped check (e.g. feed not in catalog)', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      repo.recordSettlementCheck({
        marketContractId: 'CM1',
        lazerPriceCents: undefined,
        hermesPriceCents: undefined,
        divergenceBps: undefined,
        outcome: 'skipped',
        reason: 'feed not in catalog',
      });

      expect(repo.getRecentSettlementChecks(10)[0]).toMatchObject({
        lazer_price_cents: null,
        hermes_price_cents: null,
        divergence_bps: null,
        outcome: 'skipped',
        reason: 'feed not in catalog',
      });
    });

    it('countSettlementChecksByOutcome buckets correctly and zero-fills outcomes never seen', () => {
      const repo = new AdminActivityRepository(':memory:', makeConfig());
      repo.recordSettlementCheck({
        marketContractId: 'CM1',
        lazerPriceCents: 16n,
        hermesPriceCents: 16n,
        divergenceBps: 0,
        outcome: 'ok',
        reason: undefined,
      });
      repo.recordSettlementCheck({
        marketContractId: 'CM2',
        lazerPriceCents: undefined,
        hermesPriceCents: undefined,
        divergenceBps: undefined,
        outcome: 'skipped',
        reason: 'no parsed Lazer price',
      });

      expect(repo.countSettlementChecksByOutcome()).toEqual({ ok: 1, skipped: 1, failed: 0 });
    });
  });
});
