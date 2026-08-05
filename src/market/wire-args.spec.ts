import { Keypair, scValToNative } from '@stellar/stellar-sdk';
import { marketSpec } from './contracts';
import { buildSponsoredCallArgs, coerceWireArgs, AUTH_ADDRESS_PARAM, SPONSORABLE_FUNCTIONS } from './wire-args';

/**
 * Regression coverage for a real bug: `AuthRelayService` originally built
 * sponsored calls straight from client-supplied `wireArgs`, which never
 * included the wallet's own address at all (the frontend only ever sent
 * things like `prediction`/`collateral_amount`). `coerceWireArgs` silently
 * *skips* any parameter missing from its input rather than erroring, so
 * this didn't fail loudly — every trade would have broken downstream
 * instead, either at simulation (no valid Address where the contract
 * expects one) or at the "no authorization entry recorded" check in
 * `AuthRelayService.prepare`. Exercising the real market spec here (not a
 * hand-rolled fake) so this stays honest about what `contract.Spec` would
 * actually accept.
 */
describe('buildSponsoredCallArgs', () => {
  const wallet = Keypair.random().publicKey();
  const other = Keypair.random().publicKey();

  it('every sponsorable function has a known auth-address parameter', () => {
    for (const fn of SPONSORABLE_FUNCTIONS) {
      expect(marketSpec.getFunc(fn).inputs().some((i) => i.name().toString() === AUTH_ADDRESS_PARAM[fn])).toBe(
        true,
      );
    }
  });

  it('injects the wallet address into "user" for buy, even though the caller never supplied it', () => {
    const scArgs = buildSponsoredCallArgs(marketSpec, 'buy', wallet, {
      prediction: 'Yes',
      collateral_amount: '1000',
      min_shares_out: '0',
    });
    expect(scValToNative(scArgs[0])).toBe(wallet);
  });

  it('injects the wallet address into "user" for split/merge/sell/redeem', () => {
    for (const fn of ['split', 'merge', 'redeem'] as const) {
      const wireArgs: Record<string, string> = fn === 'redeem' ? {} : { amount: '500' };
      const scArgs = buildSponsoredCallArgs(marketSpec, fn, wallet, wireArgs);
      expect(scValToNative(scArgs[0])).toBe(wallet);
    }

    const sellArgs = buildSponsoredCallArgs(marketSpec, 'sell', wallet, {
      prediction: 'No',
      shares_in: '100',
      min_collateral_out: '0',
    });
    expect(scValToNative(sellArgs[0])).toBe(wallet);
  });

  it('injects the wallet address into "from" for transfer, leaving the caller-supplied "to" untouched', () => {
    const scArgs = buildSponsoredCallArgs(marketSpec, 'transfer', wallet, {
      to: other,
      prediction: 'Yes',
      amount: '250',
    });
    // transfer(from, to, prediction, amount) — from is injected, to is caller-supplied.
    expect(scValToNative(scArgs[0])).toBe(wallet);
    expect(scValToNative(scArgs[1])).toBe(other);
  });

  it('a caller-supplied address is overridden by the wallet address, not merged/ignored', () => {
    // If a caller tried to pass a spoofed 'user' in wireArgs, the injected
    // wallet address (derived server-side from the signed entry) must win —
    // otherwise the auth-address binding this whole fix exists for is moot.
    const scArgs = buildSponsoredCallArgs(marketSpec, 'redeem', wallet, {
      user: other,
    } as unknown as Record<string, string>);
    expect(scValToNative(scArgs[0])).toBe(wallet);
  });

  it('throws for a function with no known auth-address parameter', () => {
    expect(() => buildSponsoredCallArgs(marketSpec, 'get_market', wallet, {})).toThrow(
      /not a sponsorable function/,
    );
  });
});

describe('coerceWireArgs', () => {
  it('silently omits parameters absent from wireArgs rather than throwing — the exact behavior that made the address bug quiet', () => {
    const args = coerceWireArgs(marketSpec, 'buy', { prediction: 'Yes' });
    expect(args).not.toHaveProperty('user');
    expect(args).not.toHaveProperty('collateral_amount');
    expect(args).toHaveProperty('prediction');
  });
});
