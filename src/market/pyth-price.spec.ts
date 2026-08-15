import { hermesPriceToCents, fetchHermesPriceCents } from './pyth-price';

describe('hermesPriceToCents', () => {
  it('scales a typical negative-exponent price into whole cents', () => {
    // 0.10234567 USD (price=10234567, expo=-8) -> 10.234567 cents -> rounds to 10
    expect(hermesPriceToCents('10234567', -8)).toBe(10n);
  });

  it('rounds to the nearest cent instead of truncating', () => {
    // 0.105 USD -> 10.5 cents -> rounds up to 11, not down to 10
    expect(hermesPriceToCents('105', -3)).toBe(11n);
  });

  it('handles a non-negative scaled exponent', () => {
    expect(hermesPriceToCents('5', 0)).toBe(500n);
  });
});

describe('fetchHermesPriceCents', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the parsed price converted to cents', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ parsed: [{ price: { price: '10000000', expo: -8 } }] }),
    }) as unknown as typeof fetch;

    await expect(fetchHermesPriceCents('https://hermes.example', '0xfeed')).resolves.toBe(10n);
  });

  it('throws on a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    await expect(fetchHermesPriceCents('https://hermes.example', '0xfeed')).rejects.toThrow(
      'Hermes price lookup failed: 503',
    );
  });

  it('throws when the response has no parsed price', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ parsed: [] }) }) as unknown as typeof fetch;

    await expect(fetchHermesPriceCents('https://hermes.example', '0xfeed')).rejects.toThrow(/no parsed price/);
  });

  it('bounds the fetch with an abort signal instead of leaving it unbounded', async () => {
    // Regression for a real latent bug: called synchronously inside
    // MarketService.trySettle's try block, an unbounded fetch hanging on an
    // unresponsive Hermes endpoint would mean trySettle never reaches
    // stellar.settle() *or* the catch block — a genuine silent stop, the
    // one thing that class's own doc comment says never happens. Asserted
    // structurally (a real signal is passed) rather than by actually
    // waiting out a real timer here, which would leave an unref'd
    // AbortSignal.timeout() handle dragging out this whole test suite's
    // teardown for no extra confidence — the timeout value itself isn't
    // the interesting part to protect against regressing.
    let capturedSignal: AbortSignal | undefined;
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        json: async () => ({ parsed: [{ price: { price: '10000000', expo: -8 } }] }),
      });
    }) as unknown as typeof fetch;

    await fetchHermesPriceCents('https://hermes.example', '0xfeed');

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
