/**
 * NEAR Intents 1Click API client (https://1click.chaindefuser.com, spec at /docs/v0/openapi.yaml).
 *
 * Verified Nov 10 2026: tokens, quote (dry and real) and status work without an API key (1Click
 * then adds its own fee, e.g. 20 bps on SOL→USDC, 1 bp on Base USDC→USDC); CORS allows any
 * origin; mainnet only (no testnet chains). Delivery goes to the user's own NEAR account and
 * the app then deposits with ft_transfer_call. `customRecipientMsg` (ft_transfer_call straight
 * into twooptions) is not used: the contract credits `sender_id`, which would be the intents
 * contract, not the user.
 */

const BASE = 'https://1click.chaindefuser.com/v0';

/** Native USDC on NEAR mainnet: what 1Click delivers and what a mainnet twooptions should accept. */
export const NEAR_USDC_MAINNET = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const NEAR_USDC_ASSET = `nep141:${NEAR_USDC_MAINNET}`;

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
}

export interface QuoteParams {
  dry: boolean;
  originAsset: string;
  /** Smallest units of the origin asset. */
  amount: bigint;
  refundTo: string;
  recipient: string;
  slippageBps: number;
  deadline: Date;
}

export interface OneClickQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline?: string;
  withdrawFee?: string;
}

export interface QuoteResult {
  quote: OneClickQuote;
  /** 1Click's own fee on this quote, bps (charged when no API key is used). */
  appFeeBps: number;
}

export type SwapStatus =
  | 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';

export interface StatusResult {
  status: SwapStatus;
  amountOut: string | null;
  refundReason: string | null;
  nearTxHashes: string[];
}

export const STATUS_TEXT: Record<SwapStatus, string> = {
  PENDING_DEPOSIT: 'Waiting for your deposit on the source chain.',
  KNOWN_DEPOSIT_TX: 'Deposit seen, waiting for confirmations.',
  INCOMPLETE_DEPOSIT: 'Less than the quoted amount arrived. Send the rest, or wait for the refund after the deadline.',
  PROCESSING: 'Swapping to USDC on NEAR.',
  SUCCESS: 'USDC delivered to your NEAR wallet.',
  REFUNDED: 'Refunded to your refund address.',
  FAILED: 'The swap failed.',
};

export const isFinal = (s: SwapStatus) => s === 'SUCCESS' || s === 'REFUNDED' || s === 'FAILED';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`1Click ${path.split('?')[0]}: ${body.message ?? res.statusText}`);
  return body as T;
}

export const fetchTokens = () => call<OneClickToken[]>('/tokens');

export async function requestQuote(p: QuoteParams): Promise<QuoteResult> {
  const r = await call<{ quote: OneClickQuote; quoteRequest: { appFees?: { fee: number }[] } }>('/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: p.dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: p.slippageBps,
      originAsset: p.originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: NEAR_USDC_ASSET,
      amount: p.amount.toString(),
      refundTo: p.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: p.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: p.deadline.toISOString(),
    }),
  });
  return { quote: r.quote, appFeeBps: (r.quoteRequest.appFees ?? []).reduce((s, f) => s + f.fee, 0) };
}

export async function fetchStatus(depositAddress: string, depositMemo?: string): Promise<StatusResult> {
  const q = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
  const r = await call<{ status: SwapStatus; swapDetails?: { amountOut?: string; refundReason?: string; nearTxHashes?: string[] } }>(`/status?${q}`);
  return {
    status: r.status,
    amountOut: r.swapDetails?.amountOut ?? null,
    refundReason: r.swapDetails?.refundReason ?? null,
    nearTxHashes: r.swapDetails?.nearTxHashes ?? [],
  };
}

/** Source assets offered in the widget, in display order. Matched against /tokens at runtime. */
export const SOURCES: { blockchain: string; symbol: string; label: string }[] = [
  { blockchain: 'sol', symbol: 'SOL', label: 'SOL · Solana' },
  { blockchain: 'sol', symbol: 'USDC', label: 'USDC · Solana' },
  { blockchain: 'eth', symbol: 'ETH', label: 'ETH · Ethereum' },
  { blockchain: 'eth', symbol: 'USDC', label: 'USDC · Ethereum' },
  { blockchain: 'base', symbol: 'ETH', label: 'ETH · Base' },
  { blockchain: 'base', symbol: 'USDC', label: 'USDC · Base' },
  { blockchain: 'arb', symbol: 'ETH', label: 'ETH · Arbitrum' },
  { blockchain: 'arb', symbol: 'USDC', label: 'USDC · Arbitrum' },
  { blockchain: 'btc', symbol: 'BTC', label: 'BTC · Bitcoin' },
];

const EVM = new Set(['eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera', 'scroll', 'monad', 'xlayer', 'plasma']);

/** Loose format check for the refund address on the source chain; 1Click validates fully. */
export function refundAddressError(blockchain: string, addr: string): string | null {
  const a = addr.trim();
  if (!a) return 'Enter the address you will send from, for refunds.';
  if (EVM.has(blockchain)) return /^0x[0-9a-fA-F]{40}$/.test(a) ? null : 'Expected a 0x… address.';
  if (blockchain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) ? null : 'Expected a Solana address.';
  if (blockchain === 'btc') return /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a) ? null : 'Expected a Bitcoin address.';
  return null;
}

/** A swap in flight, persisted so closing the dialog or reloading does not lose it. */
export interface PendingSwap {
  account: string;
  depositAddress: string;
  depositMemo?: string;
  sourceLabel: string;
  amountInFormatted: string;
  amountOut: string;
  deadline: string;
  createdAt: number;
  simulated: boolean;
  /** Set once USDC has arrived, so a reload shows the result instead of re-running the swap. */
  deliveredAmount?: string;
}

const PENDING_KEY = 'twooptions-1click-pending';

export function loadPending(account: string): PendingSwap | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as PendingSwap | null;
    return p && p.account === account ? p : null;
  } catch {
    return null;
  }
}

export function savePending(p: PendingSwap | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* storage blocked: the swap still completes, only resume is lost */ }
}
