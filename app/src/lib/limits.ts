/**
 * Size limits the agent enforces before it signs a quote (agent/twooptions_agent/quoter.py,
 * `check_limits`): per trade, per account and series, per underlying. The app mirrors the first
 * two so the ticket can say why before asking for a quote. Same rule: a trade that only reduces
 * the position is always allowed, so anyone can close.
 */

export interface TradeLimits {
  /** Size units (1e6 = one contract); null means no limit. */
  maxTradeSize: bigint | null;
  maxPosition: bigint | null;
  maxOpenInterest: bigint | null;
}

const contracts = (units: bigint) => `${Number(units) / 1e6}`;

/** Why this trade would be refused, or null. `held` is the taker's signed position in the series. */
export function limitError(limits: TradeLimits | null, side: 'Buy' | 'Sell', size: bigint, held: bigint): string | null {
  if (!limits) return null;
  const next = held + (side === 'Buy' ? size : -size);
  const abs = (x: bigint) => (x < 0n ? -x : x);
  if (abs(next) <= abs(held) && next * held >= 0n) return null; // closing
  if (limits.maxTradeSize != null && size > limits.maxTradeSize) return `Max ${contracts(limits.maxTradeSize)} contracts per trade on this deployment.`;
  if (limits.maxPosition != null && abs(next) > limits.maxPosition) return `Max ${contracts(limits.maxPosition)} contracts held per series on this deployment.`;
  return null;
}
