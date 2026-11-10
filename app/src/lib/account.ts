import type { AccountState, Params, Series } from './contract';
import { accruedFunding } from './margin';
import { BPS } from './units';

/** Funding the contract will settle on the next touch; null if any position lacks entry_index. */
export function pendingFunding(account: AccountState, series: Map<string, Series>): bigint | null {
  let total = 0n;
  for (const p of account.positions) {
    const s = series.get(p.series);
    if (!s || p.entryIndex == null) return null;
    total += accruedFunding(p.size, s.fundingIndex, p.entryIndex);
  }
  return total;
}

/**
 * Largest amount `withdraw` should accept right now: all cash when flat, otherwise what keeps
 * equity at the initial ratio. Conservative when pending funding is unknown (equity from the
 * view already excludes it, so this may slightly overstate by the unsettled funding).
 */
export function maxWithdraw(account: AccountState, series: Map<string, Series>, p: Params): bigint {
  const owed = pendingFunding(account, series) ?? 0n;
  const cash = account.collateral - owed;
  if (cash <= 0n) return 0n;
  if (account.positions.length === 0) return cash;
  if (account.equity == null || account.requirement == null) return 0n;
  const equity = account.equity - owed;
  const free = equity - (account.requirement * p.initial_ratio_bps + BPS - 1n) / BPS;
  const out = free < cash ? free : cash;
  return out > 0n ? out : 0n;
}
