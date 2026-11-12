/**
 * Everlasting option fair value and greeks (Paradigm series, as in our earlier project's core/everlasting.py, gks2022004/nerf@00fe59b):
 *
 *   V = Σ_{n=1}^{50} (1/2)^n · BS(S, K, σ, r = 0, T = n·f),  f = 1 hour
 *
 * Floats on purpose: used by the mock agent and for charts, never to build a transaction.
 */

export type Kind = 'Call' | 'Put';

/** Flat vols for local pricing (demo market, charts, chain fallback without an agent). */
export const DEFAULT_VOL = { BTC: 0.5, ETH: 0.6, SOL: 0.8, NEAR: 0.9 } as const;

export const HOURS_PER_YEAR = 8_760;
export const FUNDING_PERIOD_YEARS = 1 / HOURS_PER_YEAR;
export const N_TERMS = 50;
/** Funding periods per day in the agent's funding formula: hourly = (mark − intrinsic) / 24. */
export const FUNDING_PERIODS_PER_DAY = 24;

/** erf with |error| < 1.2e-7 (Numerical Recipes erfc, Chebyshev fit). */
function erf(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
  );
  return x >= 0 ? 1 - r : r - 1;
}

export const normCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));
export const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export interface Greeks {
  delta: number;
  gamma: number;
  /** Per year. */
  theta: number;
  /** Per 1 vol point (0.01). */
  vega: number;
}

export const intrinsicF = (kind: Kind, S: number, K: number) => Math.max(kind === 'Call' ? S - K : K - S, 0);

function bs(S: number, K: number, T: number, sigma: number, kind: Kind): { price: number } & Greeks {
  if (S <= 0 || K <= 0) return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const pdf = normPdf(d1);
  const gamma = pdf / (S * sigma * sqrtT);
  const vega = S * pdf * sqrtT * 0.01;
  const theta = -(S * pdf * sigma) / (2 * sqrtT);
  if (kind === 'Call') {
    return { price: S * normCdf(d1) - K * normCdf(d2), delta: normCdf(d1), gamma, theta, vega };
  }
  return { price: K * normCdf(-d2) - S * normCdf(-d1), delta: normCdf(d1) - 1, gamma, theta, vega };
}

export function everlasting(S: number, K: number, sigma: number, kind: Kind): { price: number } & Greeks {
  let price = 0, delta = 0, gamma = 0, theta = 0, vega = 0;
  let w = 1;
  for (let n = 1; n <= N_TERMS; n++) {
    w *= 0.5;
    const g = bs(S, K, n * FUNDING_PERIOD_YEARS, sigma, kind);
    price += w * g.price;
    delta += w * g.delta;
    gamma += w * g.gamma;
    theta += w * g.theta;
    vega += w * g.vega;
  }
  return { price, delta, gamma, theta, vega };
}

/** Funding a long pays per contract per hour, in USD. Positive = longs pay. */
export const hourlyFundingUsd = (mark: number, S: number, K: number, kind: Kind) =>
  (mark - intrinsicF(kind, S, K)) / FUNDING_PERIODS_PER_DAY;
