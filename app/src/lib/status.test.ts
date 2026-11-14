import { expect, test } from 'bun:test';
import type { AgentHealth, HedgeStatus } from '../backend/types';
import type { Params, Series, Vault } from './contract';
import { buildStatus, type Check, type StatusInput } from './status';
import { NS_PER_MS, SPOT_SCALE, USDC_UNIT } from './units';

const HOUR_MS = 3_600_000;
/** 20 minutes into an hourly funding interval. */
const NOW = 498_500 * HOUR_MS + 20 * 60_000;
const EPOCH = 498_500n;
const ns = (ms: number) => BigInt(ms) * NS_PER_MS;

const params = {
  max_quote_ttl_ns: 30_000_000_000n, max_spot_age_ns: 30_000_000_000n, max_positions: 16,
  max_funding_rate: 50_000_000n, funding_interval_ns: 3_600_000_000_000n, lp_cooldown_ns: 3_600_000_000_000n,
  min_deposit: 1_000_000n, initial_ratio_bps: 15_000n, close_only_ratio_bps: 13_000n, liquidation_ratio_bps: 11_500n,
  vault_ratio_bps: 12_000n, min_time_value_bps: 20n, max_time_value_bps: 400n, tv_reserve_bps: 150n,
  min_margin_per_contract: 5_000_000n, mark_band_bps: 100n, max_epoch_outflow_bps: 1_000n,
} as Params;

const series = (id: string, lastEpoch: bigint, active = true): Series => ({
  id, underlying: 'ETH', strike: 2_000n * SPOT_SCALE, kind: id.endsWith('C') ? 'Call' : 'Put',
  fundingIndex: 0n, lastMark: 0n, lastEpoch, netTraderSize: 0n, active, refMark: null, refSpot: null,
});
const vault = (over: Partial<Vault> = {}): Vault => ({
  cash: 250_000n * USDC_UNIT, totalShares: 250_000n * USDC_UNIT, pendingClaims: 0n, insurance: 0n,
  equity: 250_000n * USDC_UNIT, requirement: 0n, epochNetOutflow: 0n, epochStartCash: 250_000n * USDC_UNIT, ...over,
});
const health = (over: Partial<NonNullable<AgentHealth['keeper']>> = {}): AgentHealth => ({
  keeper: { lastSpotPostMs: { ETH: NOW - 4_000 }, spotHold: {}, liquidations: 0, liquidated: [], errors: {}, ...over },
  hedger: true,
});
const hedge = (over: Partial<HedgeStatus> = {}): HedgeStatus => ({
  enabled: true, venue: 'hyperliquid', network: 'testnet', account: '0xabc', updatedMs: NOW - 3_000, error: null,
  accountValue: 1_000, deadbandUsd: 25, rehedgeMoveBps: 50,
  rows: [{ underlying: 'ETH', target: 0.8, position: 0.8, gap: 0, band: 0.2, state: 'balanced', reason: 'inside the gamma band', venueMid: 2_000, basisBps: 0, unrealizedPnl: 0 }],
  orders: [], ...over,
});

/** Everything healthy on a live deployment. Each test breaks one thing. */
const good = (over: Partial<StatusInput> = {}): StatusInput => ({
  mode: 'chain', loaded: true, contractError: null, paused: false, params,
  series: [series('ETH-2000-C', EPOCH), series('ETH-2000-P', EPOCH)],
  spots: { ETH: { price: 2_000n * SPOT_SCALE, tsNs: ns(NOW - 4_000) } },
  vault: vault(), solvency: { ledgerTotal: 257_000_000_000n, netInflow: 257_000_000_000n },
  agentKind: 'http', agentError: null, quoted: 2, agentKeyRegistered: true, health: health(), hedge: hedge(), ...over,
});
const check = (i: StatusInput, id: Check['id']) => buildStatus(i, NOW).checks.find(c => c.id === id)!;

test('a healthy deployment is operational and every component says so', () => {
  const r = buildStatus(good(), NOW);
  expect([r.overall, r.headline]).toEqual(['operational', 'All systems operational']);
  expect(r.checks.map(c => [c.id, c.level])).toEqual([
    ['contract', 'ok'], ['spot', 'ok'], ['solvency', 'ok'], ['agent', 'ok'], ['agent-key', 'ok'], ['keeper', 'ok'],
    ['funding', 'ok'], ['vault', 'ok'], ['hedger', 'ok'],
  ]);
  expect(r.checks.filter(c => c.critical).map(c => c.id)).toEqual(['contract', 'spot', 'solvency', 'agent', 'agent-key']);
});

test('what stops trading is an outage; what does not is only degraded', () => {
  // Each critical component down on its own is an outage that names it.
  const outages: [Partial<StatusInput>, string][] = [
    [{ contractError: 'HTTP 503' }, 'Outage: contract'],
    [{ spots: {} }, 'Outage: price feed'],
    [{ solvency: { ledgerTotal: 1n, netInflow: 2n } }, 'Outage: ledger'],
    [{ agentError: 'agent /chain: HTTP 502' }, 'Outage: quote server'],
    [{ agentKeyRegistered: false }, 'Outage: agent key'],
  ];
  for (const [over, headline] of outages) {
    const r = buildStatus(good(over), NOW);
    expect([r.overall, r.headline]).toEqual(['outage', headline]);
  }
  // A non-critical component down never becomes an outage.
  const late = buildStatus(good({ series: [series('ETH-2000-C', EPOCH - 3n)] }), NOW);
  expect([late.overall, late.headline]).toEqual(['degraded', 'Degraded: funding settlement']);
  expect(buildStatus(good({ paused: true }), NOW).overall).toBe('degraded');
  // Components that are off or still unknown do not count against the system.
  const quiet = buildStatus(good({ hedge: hedge({ enabled: false }), agentKeyRegistered: null, solvency: null }), NOW);
  expect(quiet.overall).toBe('operational');
});

test('an unreadable contract is one alarm, not a false report that the price or the funding is missing', () => {
  // Seen live: a rate-limited RPC (HTTP 429) made every read fail while the system was healthy.
  const blind = good({ contractError: 'test.rpc.fastnear.com: HTTP 429', spots: {}, series: [], vault: null, params: null });
  const r = buildStatus(blind, NOW);
  expect([r.overall, r.headline]).toEqual(['outage', 'Outage: contract']);
  for (const id of ['spot', 'funding', 'vault'] as const) {
    expect(r.checks.find(c => c.id === id)).toMatchObject({ level: 'unknown', summary: 'Unknown while the contract cannot be read.' });
  }
  // Even with the last good data still in hand, it does not vouch for a price it can no longer read.
  expect(check(good({ contractError: 'HTTP 429' }), 'spot').level).toBe('unknown');
});

test('before the first read the page says it is checking, unless something already failed', () => {
  const r = buildStatus(good({ loaded: false, params: null, series: [], spots: {}, vault: null, solvency: null, health: null, hedge: null, quoted: 0, agentKeyRegistered: null }), NOW);
  expect([r.overall, r.headline]).toEqual(['checking', 'Checking…']);
  expect(buildStatus(good({ loaded: false, contractError: 'Failed to fetch' }), NOW).overall).toBe('outage');
});

test('price feed: fresh, past half the limit, stale, and missing', () => {
  const at = (ageMs: number) => check(good({ spots: { ETH: { price: 2_000n * SPOT_SCALE, tsNs: ns(NOW - ageMs) } } }), 'spot');
  expect(at(4_000).level).toBe('ok');
  expect(at(4_000).summary).toContain('ETH 4 s old (limit 30 s)');
  expect(at(15_000).level).toBe('ok'); // exactly half is still fine
  expect(at(15_001).level).toBe('warn');
  expect(at(16_000).summary).toContain('the agent stops signing quotes');
  expect(at(30_000).level).toBe('warn'); // the contract accepts a price exactly at the limit
  expect(at(30_001).level).toBe('down');
  expect(at(456_000).summary).toContain('ETH is 8 min old (limit 30 s). The contract refuses trades');
  expect(check(good({ spots: {} }), 'spot').summary).toContain('ETH has no price on chain');
  expect(check(good({ series: [] }), 'spot').level).toBe('off');
});

test('funding: settled, settling within the grace period, late, and missed', () => {
  const two = (a: bigint, b: bigint) => good({ series: [series('ETH-2000-C', a), series('ETH-2000-P', b)] });
  expect(check(two(EPOCH, EPOCH), 'funding').summary).toBe('All 2 series are settled for the current interval (every 60 min).');
  // One series still on the previous interval: fine 4 minutes in, late 20 minutes in.
  const early = buildStatus(two(EPOCH, EPOCH - 1n), NOW - 16 * 60_000).checks.find(c => c.id === 'funding')!;
  expect([early.level, early.summary]).toEqual(['ok', 'Settling now: 1 of 2 series settled, 4 min into the interval.']);
  const late = check(two(EPOCH, EPOCH - 1n), 'funding');
  expect([late.level, late.summary]).toEqual(['warn', 'Running late: 1 of 2 series settled, 20 min into the interval (every 60 min).']);
  // Two or more intervals behind is a missed settlement.
  const missed = check(two(EPOCH, EPOCH - 4n), 'funding');
  expect(missed.level).toBe('down');
  expect(missed.summary).toContain('1 of 2 series missed a settlement (up to 4 intervals behind)');
  expect(check(two(0n, 0n), 'funding').summary).toContain('2 of 2 series have never been settled');
  // A deactivated series is not expected to settle.
  expect(check(good({ series: [series('ETH-2000-C', EPOCH), series('ETH-2000-P', 0n, false)] }), 'funding').level).toBe('ok');
  // On a 3-minute interval the grace period shrinks with it (75% of the interval).
  const fast = { ...params, funding_interval_ns: 180_000_000_000n } as Params;
  const e = BigInt(Math.floor(NOW / 180_000));
  const into = NOW % 180_000; // 120 s into this 3-minute interval
  const at = (ms: number) => buildStatus(good({ params: fast, series: [series('ETH-2000-C', e - 1n)] }), NOW - into + ms).checks.find(c => c.id === 'funding')!;
  expect(at(100_000).level).toBe('ok');
  expect(at(140_000).level).toBe('warn');
});

test('vault: healthy, near and at its risk limit, payout cap, no liquidity, and the circuit breaker', () => {
  const v = (over: Partial<Vault>) => check(good({ vault: vault(over) }), 'vault');
  expect(v({}).summary).toBe('Equity $250,000, no open risk.');
  expect(v({ requirement: 20_000n * USDC_UNIT }).summary).toBe('Equity $250,000, health 12.50× against a 1.20× minimum.');
  const near = v({ requirement: 170_000n * USDC_UNIT }); // 1.47x, under 1.25 x the 1.20x minimum
  expect([near.level, near.summary]).toEqual(['warn', 'Close to its risk limit (health 1.47× against a 1.20× minimum).']);
  expect(v({ requirement: 166_000n * USDC_UNIT }).level).toBe('ok'); // 1.506x, just above 1.50x
  const at = v({ requirement: 210_000n * USDC_UNIT });
  expect(at.level).toBe('warn');
  expect(at.summary).toContain('trades that add risk to the vault are refused');
  // 10% of 250,000 may be paid out per interval; 80% of that is the warning line.
  expect(v({ epochNetOutflow: 19_999n * USDC_UNIT }).level).toBe('ok');
  expect(v({ epochNetOutflow: 20_000n * USDC_UNIT }).summary).toContain('Has paid traders $20,000 of the $25,000');
  expect(v({ epochNetOutflow: -50_000n * USDC_UNIT }).level).toBe('ok'); // net receipts are not a payout
  expect(v({ totalShares: 0n }).level).toBe('warn');
  expect(v({ equity: null, requirement: null }).level).toBe('unknown');
  const halted = v({ cash: -10n * USDC_UNIT, insurance: 5n * USDC_UNIT });
  expect([halted.level, halted.summary.includes('withdrawals and LP claims are halted')]).toEqual(['down', true]);
  expect(v({ cash: -5n * USDC_UNIT, insurance: 5n * USDC_UNIT }).level).not.toBe('down'); // exactly zero is not a shortfall
});

test('ledger: backed, mismatched by one micro, unknown, and not tracked', () => {
  expect(check(good(), 'solvency').summary).toContain('add up to the $257,000 of USDC received');
  const off = check(good({ solvency: { ledgerTotal: 257_000_000_001n, netInflow: 257_000_000_000n } }), 'solvency');
  expect([off.level, off.summary.startsWith('MISMATCH')]).toEqual(['down', true]);
  expect(check(good({ solvency: null }), 'solvency').level).toBe('unknown');
  expect(check(good({ solvency: 'unavailable' }), 'solvency').level).toBe('off');
});

test('quote server and its key', () => {
  expect(check(good(), 'agent').summary).toBe('Answering and pricing 2 of 2 series.');
  expect(check(good({ quoted: 0 }), 'agent').level).toBe('warn');
  expect(check(good({ agentKind: 'mock' }), 'agent').summary).toContain('No agent is configured');
  expect(check(good({ agentKind: 'mock' }), 'agent').level).toBe('down');
  expect(check(good({ agentError: 'Failed to fetch' }), 'agent').summary).toBe('Not answering: Failed to fetch. No quotes can be signed.');
  expect(check(good({ agentKeyRegistered: false }), 'agent-key').summary).toContain('every quote it signs is rejected');
  expect(check(good({ agentKeyRegistered: null }), 'agent-key').level).toBe('unknown');
  expect(check(good({ agentKeyRegistered: null, agentError: 'Failed to fetch' }), 'agent-key').summary).toBe('Unknown: the agent did not answer, so its key could not be read.');
  expect(check(good({ agentKind: 'mock' }), 'agent-key').level).toBe('off');
});

test('keeper: running, failing jobs, a held price, no keeper, and no answer', () => {
  expect(check(good(), 'keeper').summary).toBe('Running: last price sent 4 s ago; 0 liquidations since it started.');
  expect(check(good({ health: health({ liquidations: 1 }) }), 'keeper').summary).toContain('1 liquidation since');
  const spotFail = check(good({ health: health({ errors: { spot: 'sequence must increase', funding: 'x' } }) }), 'keeper');
  expect([spotFail.level, spotFail.summary]).toEqual(['down', 'Price posts are failing: sequence must increase']);
  const fundFail = check(good({ health: health({ errors: { funding: 'epoch is not current' } }) }), 'keeper');
  expect([fundFail.level, fundFail.summary]).toEqual(['warn', 'The funding job is failing: epoch is not current']);
  const held = check(good({ health: health({ spotHold: { ETH: 'venues disagree by 80 bps' } }) }), 'keeper');
  expect([held.level, held.summary]).toEqual(['warn', 'Holding back the ETH price instead of posting it: venues disagree by 80 bps']);
  expect(check(good({ health: { keeper: null, hedger: false } }), 'keeper').level).toBe('warn');
  expect(check(good({ health: null }), 'keeper').level).toBe('unknown');
  // A keeper that is down is not itself an outage: the price-feed check is what says trading stopped.
  expect(buildStatus(good({ health: health({ errors: { spot: 'boom' } }) }), NOW).overall).toBe('degraded');
});

test('hedge: running, off, failing, silent, and on hold', () => {
  expect(check(good(), 'hedger').summary).toBe('Running on hyperliquid testnet: ETH position 0.8 against a target of 0.8. The hedge is off chain, in an account the operator holds.');
  const off = check(good({ hedge: hedge({ enabled: false }) }), 'hedger');
  expect([off.level, off.summary]).toEqual(['off', "Switched off: LPs carry the vault's net delta."]);
  expect(check(good({ hedge: hedge({ error: 'TransportError: timed out' }) }), 'hedger').summary).toContain('no order was sent: TransportError');
  expect(check(good({ hedge: hedge({ updatedMs: NOW - 60_000 }) }), 'hedger').level).toBe('ok');
  expect(check(good({ hedge: hedge({ updatedMs: NOW - 61_000 }) }), 'hedger').level).toBe('warn');
  const hold = hedge(); hold.rows[0] = { ...hold.rows[0], state: 'hold', reason: "the contract's spot is stale or missing" };
  expect(check(good({ hedge: hold }), 'hedger').summary).toBe("Holding ETH unchanged: the contract's spot is stale or missing.");
  expect(check(good({ hedge: null }), 'hedger').level).toBe('unknown');
});

test('demo mode reports the simulation and marks what does not exist there as off', () => {
  const r = buildStatus(good({ mode: 'demo', agentKind: 'mock', solvency: 'unavailable', health: null, hedge: null, agentKeyRegistered: null }), NOW);
  expect([r.overall, r.headline]).toEqual(['operational', 'Demo is running']);
  expect(Object.fromEntries(r.checks.map(c => [c.id, c.level]))).toEqual({
    contract: 'ok', spot: 'ok', solvency: 'off', agent: 'off', 'agent-key': 'off', keeper: 'off', funding: 'ok', vault: 'ok', hedger: 'off',
  });
});
