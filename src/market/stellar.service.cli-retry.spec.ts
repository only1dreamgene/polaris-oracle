import { isTransientStellarCliError } from './stellar.service';

/**
 * Regression for: back-to-back `stellar` CLI calls sharing one source
 * account (deployMarket's `deploy` immediately followed by `initialize`)
 * failed live on testnet in more shapes than a fixed allowlist of error
 * strings could keep up with — "Contract not found", "HostError:
 * Error(Storage, MissingValue)" (the same RPC-hasn't-caught-up race, worded
 * differently), "TxBadSeq", "client error (SendRequest)", and a plain
 * submission timeout, all resolved by retrying. An early version of this
 * classifier allowlisted three exact strings and missed the other two the
 * very next time it ran against real testnet. `execStellarCli` now retries
 * everything except a confirmed contract-level rejection.
 */
describe('isTransientStellarCliError', () => {
  it('flags every RPC/network-level failure shape actually seen on testnet as retryable', () => {
    expect(isTransientStellarCliError('❌ error: Contract not found: CABC123')).toBe(true);
    expect(
      isTransientStellarCliError(
        '❌ error: transaction simulation failed: HostError: Error(Storage, MissingValue)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Storage, MissingValue)], data:"trying to get non-existing value for contract instance"',
      ),
    ).toBe(true);
    expect(isTransientStellarCliError('❌ error: transaction submission failed: TxBadSeq')).toBe(true);
    expect(isTransientStellarCliError('❌ error: client error (SendRequest)')).toBe(true);
    expect(isTransientStellarCliError('❌ error: transaction submission timeout')).toBe(true);
  });

  it('does not flag a genuine contract-level rejection as retryable', () => {
    // The contract's own Result::Err (bad strike price, insufficient
    // balance, an already-finalized market, ...) fails identically every
    // time — retrying it is pure wasted delay before the same failure.
    expect(
      isTransientStellarCliError(
        '❌ error: transaction simulation failed: HostError: Error(Contract, #3)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Contract, #3)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"',
      ),
    ).toBe(false);
  });
});
