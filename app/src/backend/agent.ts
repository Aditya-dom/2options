/**
 * Agent clients. `HttpAgent` talks to Gaurav's quote server (HANDOFF_ADITYA.md §5).
 * `PricingAgent` prices locally with the same everlasting model; its quotes carry no valid
 * signature, so it can only trade against the in-browser demo contract.
 */

import { priceBand } from '../lib/margin';
import type { Params, QuoteJson, Series, SpotPoint, Underlying } from '../lib/contract';
import { everlasting, intrinsicF } from '../lib/pricing';
import { big, FUNDING_SCALE, NS_PER_MS, nowNs, SPOT_SCALE, USDC_UNIT } from '../lib/units';
import type {
  Agent, Attestation, ChainRow, ChainRowJson, FundingHistoryJson, FundingHistoryRow, QuoteRequest, SignedQuote,
} from './types';

export class HttpAgent implements Agent {
  readonly kind = 'http' as const;
  readonly canTrade = true;

  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const res = await fetch(`${this.baseUrl}${path}${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`agent ${path}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
    return res.json() as Promise<T>;
  }

  async chain(): Promise<ChainRow[]> {
    return (await this.get<ChainRowJson[]>('/chain')).map(r => ({
      series: r.series,
      bid: big(r.bid),
      ask: big(r.ask),
      mark: big(r.mark),
      delta: r.delta,
      gamma: r.gamma,
      fundingRateHourly: big(r.funding_rate_hourly),
    }));
  }

  quote(req: QuoteRequest): Promise<SignedQuote> {
    return this.get<SignedQuote>('/quote', {
      series: req.series,
      side: req.side,
      size: req.size.toString(),
      taker: req.taker,
    });
  }

  async attestation(): Promise<Attestation | null> {
    const res = await fetch(`${this.baseUrl}/attestation`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`agent /attestation: HTTP ${res.status}`);
    return res.json() as Promise<Attestation>;
  }

  async fundingHistory(limit: number): Promise<FundingHistoryRow[]> {
    const rows = await this.get<FundingHistoryJson[]>('/funding/history', { limit: String(limit) });
    return rows.map(parseFundingHistory);
  }

  async spot(): Promise<Partial<Record<Underlying, SpotPoint>>> {
    const j = await this.get<Partial<Record<Underlying, { price: string; ts_ns: string }>>>('/spot');
    const out: Partial<Record<Underlying, SpotPoint>> = {};
    for (const [u, v] of Object.entries(j)) if (v) out[u as Underlying] = { price: big(v.price), tsNs: big(v.ts_ns) };
    return out;
  }
}

export const parseFundingHistory = (r: FundingHistoryJson): FundingHistoryRow => ({
  series: r.series,
  epoch: big(r.epoch),
  mark: big(r.mark),
  perContract: big(r.per_contract),
  atMs: Number(big(r.ts_ns) / NS_PER_MS),
});

export interface PricingSources {
  spots(): Promise<Partial<Record<Underlying, SpotPoint>>>;
  series(): Promise<Series[]>;
  params(): Promise<Params>;
  /** Annualised vol per underlying. */
  vol(u: Underlying): number;
}

/**
 * Mock half-spread: 2% of time value, but at least 0.5 bp of delta-weighted spot (so deep ITM
 * strikes are not quoted for free) and half a cent (so far OTM strikes still have a market).
 */
const HALF_SPREAD_TV_FRAC = 0.02;
const HALF_SPREAD_DELTA_BPS = 0.5;
const HALF_SPREAD_MIN_USD = 0.005;
const QUOTE_TTL_MS = 10_000n;

let nonceCounter = 0n;
/** Strictly increasing per process: microsecond clock plus a counter. */
export const nextNonce = () => BigInt(Date.now()) * 1_000n + (nonceCounter++ % 1_000n);

export class PricingAgent implements Agent {
  readonly kind = 'mock' as const;

  constructor(private readonly src: PricingSources, readonly canTrade: boolean) {}

  async chain(): Promise<ChainRow[]> {
    const [spots, series, params] = await Promise.all([this.src.spots(), this.src.series(), this.src.params()]);
    const rows: ChainRow[] = [];
    for (const s of series) {
      const sp = spots[s.underlying];
      if (!sp) continue;
      rows.push(priceRow(s, sp.price, this.src.vol(s.underlying), params));
    }
    return rows;
  }

  async quote(req: QuoteRequest): Promise<SignedQuote> {
    const rows = await this.chain();
    const row = rows.find(r => r.series === req.series);
    if (!row) throw new Error(`no price for ${req.series} (spot missing?)`);
    const quote: QuoteJson = {
      series: req.series,
      taker: req.taker,
      side: req.side,
      size: req.size.toString(),
      price: (req.side === 'Buy' ? row.ask : row.bid).toString(),
      nonce: nextNonce().toString(),
      expiry_ns: (nowNs() + QUOTE_TTL_MS * NS_PER_MS).toString(),
    };
    // 64 zero bytes: the demo contract ignores it, a real contract rejects it.
    return { quote, signature: btoa(String.fromCharCode(...new Uint8Array(64))) };
  }

  spot() { return this.src.spots(); }
  async attestation() { return null; }
}

const toMicros = (usd: number) => BigInt(Math.round(usd * 1e6));

/** Fair value, greeks, a two-sided market clamped into the contract band, and the funding rate. */
export function priceRow(s: Series, spot: bigint, vol: number, p: Params): ChainRow {
  const S = Number(spot) / Number(SPOT_SCALE);
  const K = Number(s.strike) / Number(SPOT_SCALE);
  const fair = everlasting(S, K, vol, s.kind);
  const timeValue = Math.max(fair.price - intrinsicF(s.kind, S, K), 0);
  const half = Math.max(
    timeValue * HALF_SPREAD_TV_FRAC,
    (S * Math.abs(fair.delta) * HALF_SPREAD_DELTA_BPS) / 10_000,
    HALF_SPREAD_MIN_USD,
  );
  const [lo, hi] = priceBand(s.kind, spot, s.strike, p);
  const clamp = (v: bigint) => (v < lo ? lo : v > hi ? hi : v);
  const mark = clamp(toMicros(fair.price));
  const bid = clamp(toMicros(Math.max(fair.price - half, 0)));
  const ask = clamp(toMicros(fair.price + half));
  return { series: s.id, bid, ask, mark, delta: fair.delta, gamma: fair.gamma, fundingRateHourly: fundingRate(mark, S, K, s.kind, p) };
}

/** Hourly rate as a 1e9 fraction of mark: (mark − intrinsic) / 24 per hour, capped like the contract. */
export function fundingRate(mark: bigint, S: number, K: number, kind: Series['kind'], p: Params): bigint {
  if (mark <= 0n) return 0n;
  const markUsd = Number(mark) / Number(USDC_UNIT);
  const perHourUsd = (markUsd - intrinsicF(kind, S, K)) / 24;
  const rate = BigInt(Math.round((perHourUsd / markUsd) * Number(FUNDING_SCALE)));
  const cap = p.max_funding_rate;
  return rate > cap ? cap : rate < -cap ? -cap : rate;
}
