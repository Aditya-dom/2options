/**
 * The contract panics with readable text; wallets wrap it differently ("Smart contract panicked:
 * …", FunctionCallError JSON, plain Error). Pull out the contract's message and map it to what
 * the user should do next.
 */

const FRIENDLY: Array<[RegExp, string]> = [
  [/quote expired|nonce already used|quote expiry is too far/, 'That quote has expired. Get a fresh quote and submit again.'],
  [/insufficient margin for this trade/, 'Not enough margin for this trade. Deposit more USDC or reduce the size.'],
  [/vault risk limit reached|vault cannot fund this trade/, 'The vault cannot take on more risk right now. Try a smaller size or the other side.'],
  [/spot price is stale/, 'Prices are paused while the spot feed catches up. Try again in a few seconds.'],
  [/price is too far from the last funding mark/, 'This price is too far from the last funding settlement. Get a fresh quote; if it keeps happening, the price agent may be misbehaving.'],
  [/vault outflow limit reached/, 'The vault has paid out its limit for this hour. Try again after the next funding settlement.'],
  [/price is outside the allowed band/, 'The quoted price is outside the allowed band. This should not happen with the real agent; please report it.'],
  [/withdrawal would leave the account under-margined/, 'That withdrawal would leave your positions under-margined. Close or reduce positions first.'],
  [/account owes funding/, 'Your account owes funding. Deposit enough to cover it before withdrawing.'],
  [/insufficient collateral/, 'You do not have that much free collateral.'],
  [/trading is paused/, 'Trading is paused by the operator. Withdrawals still work.'],
  [/deposits are paused/, 'Deposits are paused by the operator.'],
  [/deposit below minimum/, 'That deposit is below the minimum.'],
  [/deposit first|no account/, 'Deposit USDC before trading.'],
  [/too many open series/, 'You have reached the maximum number of open series. Close one first.'],
  [/position too large|size out of range/, 'That size is outside the allowed range.'],
  [/quote is for a different taker/, 'That quote was issued to a different account. Get a fresh quote.'],
  [/invalid agent signature/, 'The quote signature was rejected. The agent key may have been rotated; get a fresh quote.'],
  [/series is not active|unknown series/, 'That series is not open for trading.'],
  [/withdrawals are halted/, 'Withdrawals are halted while the system is under-collateralized.'],
  [/claim is still in cooldown/, 'Your LP claim is still in its cooldown.'],
  [/redeeming would leave the vault under-margined|vault has insufficient free cash/, 'The vault needs that capital to back open positions. Try a smaller redemption later.'],
  [/User (rejected|cancelled)|rejected by user|User closed/i, 'Transaction cancelled in the wallet.'],
];

/** The contract's own panic message, if one can be found in a wallet or RPC error. */
export function contractMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const m = /Smart contract panicked: ([^"\\]+)/.exec(raw);
  return (m ? m[1] : raw).trim();
}

export function friendlyError(err: unknown): string {
  const msg = contractMessage(err);
  for (const [re, text] of FRIENDLY) if (re.test(msg)) return text;
  return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
}
