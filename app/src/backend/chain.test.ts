import { afterEach, expect, test } from 'bun:test';
import { ChainBackend } from './chain';

const realFetch = globalThis.fetch;
const realNow = Date.now;
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });

const PARAMS = {
  max_quote_ttl_ns: 30_000_000_000, max_spot_age_ns: 30_000_000_000, max_positions: 16, max_funding_rate: '50000000',
  funding_interval_ns: 3_600_000_000_000, lp_cooldown_ns: 3_600_000_000_000, min_deposit: '1000000',
  margin: {
    initial_ratio_bps: 15_000, close_only_ratio_bps: 13_000, liquidation_ratio_bps: 11_500, vault_ratio_bps: 12_000,
    min_time_value_bps: 20, max_time_value_bps: 400, tv_reserve_bps: 150, min_margin_per_contract: '5000000', mark_band_bps: 100,
  },
  initial_ratio_bps: 15_000, close_only_ratio_bps: 13_000, liquidation_ratio_bps: 11_500, vault_ratio_bps: 12_000,
  min_time_value_bps: 20, max_time_value_bps: 400, tv_reserve_bps: 150, min_margin_per_contract: '5000000', mark_band_bps: 100,
  max_epoch_outflow_bps: 1_000,
};

/** Serve view calls from `answers` (by method name) and record which methods were asked for. */
function serve(answers: Record<string, () => unknown>) {
  const asked: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const method = JSON.parse(init.body).params.method_name as string;
    asked.push(method);
    const value = answers[method]();
    return new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }));
  }) as unknown as typeof fetch;
  return asked;
}
const backend = () => new ChainBackend('c.testnet', 'usdc.testnet', ['https://a.example'], async () => { throw new Error('no wallet in this test'); });

test('the parameters are read once a minute, not on every poll', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const asked = serve({ get_params: () => PARAMS });
  const b = backend();
  const first = await b.getParams();
  now += 59_000;
  expect(await b.getParams()).toBe(first);
  expect(asked).toEqual(['get_params']);
  now += 2_000;
  await b.getParams();
  expect(asked).toEqual(['get_params', 'get_params']);
});

test('a failed read of the parameters is not remembered', async () => {
  let fail = true;
  const asked = serve({ get_params: () => { if (fail) throw new TypeError('Failed to fetch'); return PARAMS; } });
  const b = backend();
  await expect(b.getParams()).rejects.toThrow();
  fail = false;
  expect((await b.getParams()).max_positions).toBe(16);
  expect(asked.length).toBeGreaterThanOrEqual(2);
});

test('an account seen registered with the token is not asked about again; one that is not, is', async () => {
  let registered = false;
  const asked = serve({ storage_balance_of: () => (registered ? { total: '1250000000000000000000', available: '0' } : null) });
  const b = backend();
  expect(await b.usdcRegistered('alice.testnet')).toBe(false);
  expect(await b.usdcRegistered('alice.testnet')).toBe(false);
  registered = true;
  expect(await b.usdcRegistered('alice.testnet')).toBe(true);
  expect(await b.usdcRegistered('alice.testnet')).toBe(true);
  expect(asked.length).toBe(3);
  expect(await b.usdcRegistered('bob.testnet')).toBe(true); // remembered per account
  expect(asked.length).toBe(4);
});
