/**
 * Fixed-point units used by the perennia contract. All on-chain numbers are integers; the JSON
 * API carries 64/128-bit values as decimal strings. Keep them as bigint until display.
 *
 * | quantity                         | scale |
 * |----------------------------------|-------|
 * | USDC, premium, mark, funding idx | 1e6   |
 * | spot, strike                     | 1e8   |
 * | position size                    | 1e6 per contract, signed |
 * | funding rate                     | 1e9 fraction of mark per hour |
 * | ratios, fees                     | bps   |
 */

export const USDC_DECIMALS = 6;
export const SPOT_DECIMALS = 8;
export const SIZE_DECIMALS = 6;
export const FUNDING_RATE_DECIMALS = 9;

export const USDC_UNIT = 1_000_000n;
export const SIZE_SCALE = 1_000_000n;
export const SPOT_SCALE = 100_000_000n;
export const FUNDING_SCALE = 1_000_000_000n;
export const BPS = 10_000n;
export const NS_PER_MS = 1_000_000n;

/** Parse a JSON number string (U128/I128/U64) into a bigint. Throws on anything else. */
export function big(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`not a safe integer: ${v}`);
    return BigInt(v);
  }
  if (!/^-?\d+$/.test(v)) throw new Error(`not an integer string: ${JSON.stringify(v)}`);
  return BigInt(v);
}

/**
 * Parse a user-typed decimal ("12.5", "0.001") into fixed-point units. Returns null for empty,
 * malformed or over-precise input instead of silently rounding someone's money.
 */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const whole = m[1] || '0';
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Exact decimal string with trailing zeros trimmed to at least `minFrac` digits. */
export function formatUnits(v: bigint, decimals: number, minFrac = 0): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

/** Lossy conversion for charts and greeks. Never feed the result back into a transaction. */
export function toNumber(v: bigint, decimals: number): number {
  return Number(v) / 10 ** decimals;
}

/**
 * Display a fixed-point value rounded half away from zero to `digits` places with thousands
 * separators. Option prices are tiny next to spot, so callers choose digits per column.
 */
export function fmtFixed(v: bigint, decimals: number, digits: number): string {
  const neg = v < 0n;
  let abs = neg ? -v : v;
  if (digits < decimals) {
    const drop = 10n ** BigInt(decimals - digits);
    abs = (abs + drop / 2n) / drop;
  } else {
    abs *= 10n ** BigInt(digits - decimals);
  }
  const scale = 10n ** BigInt(digits);
  const whole = (abs / scale).toLocaleString('en-US');
  const frac = digits > 0 ? '.' + (abs % scale).toString().padStart(digits, '0') : '';
  const zero = abs === 0n;
  return (neg && !zero ? '-' : '') + whole + frac;
}

const dollars = (s: string) => (s.startsWith('-') ? '-$' + s.slice(1) : '$' + s);
export const fmtUsdc = (micros: bigint, digits = 2) => dollars(fmtFixed(micros, USDC_DECIMALS, digits));
export const fmtSpot = (v: bigint, digits = 2) => dollars(fmtFixed(v, SPOT_DECIMALS, digits));
/** Float USD for charts and greeks-derived figures. */
export const fmtUsd = (v: number, digits = 2) =>
  dollars(v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
export const fmtSize = (v: bigint, digits = 3) => fmtFixed(v, SIZE_DECIMALS, digits);
export const fmtSignedUsdc = (micros: bigint, digits = 2) =>
  (micros > 0n ? '+' : '') + fmtUsdc(micros, digits);

/** Option prices: more decimals when small so a $0.004 put is not shown as $0.00. */
export function fmtPremium(micros: bigint): string {
  const abs = micros < 0n ? -micros : micros;
  if (abs < 50n) return '$0.00'; // would round to $0.0000

  if (abs < 10_000n) return fmtUsdc(micros, 4);
  return fmtUsdc(micros, 2);
}

export const nowNs = (): bigint => BigInt(Date.now()) * NS_PER_MS;
