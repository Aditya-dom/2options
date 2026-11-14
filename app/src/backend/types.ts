import type { TradeLimits } from '../lib/limits';
import type { Fill } from '../lib/history';
import type {
  AccountState, LpClaim, Params, QuoteJson, Series, Side, SpotPoint, Underlying, Vault,
} from '../lib/contract';

/** Everything the UI can ask the contract to do, as data. Each backend decides how to send it. */
export type Call =
  | { kind: 'deposit'; amount: bigint }
  | { kind: 'lp_deposit'; amount: bigint }
  | { kind: 'withdraw'; amount: bigint }
  | { kind: 'trade'; quote: QuoteJson; signature: string }
  /** Several trades in one transaction: all fill or none do. Legs run in the given order. */
  | { kind: 'trade_batch'; legs: { quote: QuoteJson; signature: string }[] }
  | { kind: 'lp_request_redeem'; shares: bigint }
  | { kind: 'lp_claim' }
  | { kind: 'register_usdc' }
  /** The test token's rate-limited faucet (testnet). */
  | { kind: 'faucet' };

export interface CallResult {
  /** Final transaction hash when the wallet returned one (redirect wallets do not). */
  txHash: string | null;
  /** Contract events seen in the receipts, e.g. `WithdrawRefunded`. */
  events: string[];
}

/** The test token's faucet: what one claim pays and when the account may claim next. */
export interface FaucetStatus {
  amount: bigint;
  /** When the next claim opens (ms since epoch); null when a claim would succeed now. */
  nextClaimMs: number | null;
}

export interface Backend {
  readonly mode: 'demo' | 'chain';
  readonly contractId: string;
  readonly usdcId: string;

  getParams(): Promise<Params>;
  listSeries(): Promise<Series[]>;
  getSpot(u: Underlying): Promise<SpotPoint | null>;
  getVault(): Promise<Vault>;
  isPaused(): Promise<boolean>;
  getAccount(accountId: string): Promise<AccountState | null>;
  getLpShares(accountId: string): Promise<bigint>;
  getLpClaim(accountId: string): Promise<LpClaim | null>;
  /** The user's USDC wallet balance (not deposited), micros. */
  usdcBalance(accountId: string): Promise<bigint>;
  /** Whether the account can receive USDC; withdrawals to an unregistered account bounce. */
  usdcRegistered(accountId: string): Promise<boolean>;
  /** `is_agent_key`: whether the contract accepts signatures from this key. Null when not applicable. */
  isAgentKey(key: string): Promise<boolean | null>;
  /** `get_solvency`: the contract's ledger against the USDC it has received. Only the status page reads it. */
  getSolvency?(): Promise<Solvency>;

  /** The account's fills, newest first. */
  tradeHistory(accountId: string): Promise<Fill[]>;

  submit(accountId: string, call: Call): Promise<CallResult>;
  /** Null when the collateral token has no faucet (real USDC). */
  faucetStatus?(accountId: string): Promise<FaucetStatus | null>;
  /** Set up whatever lets trades sign without a wallet popup (chain mode). */
  prepareTrading?(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Agent HTTP API (HANDOFF_ADITYA.md §5, proposed). Units as in the contract.
// ---------------------------------------------------------------------------------------------

export interface ChainRowJson {
  series: string;
  /** USDC micros per contract. */
  bid: string;
  ask: string;
  mark: string;
  delta: number;
  gamma: number;
  /** 1e9-scaled fraction of mark per hour, signed (same scale as FundingUpdate.rate). */
  funding_rate_hourly: string;
  /** Annualised implied vol the agent priced with, e.g. 0.61. */
  iv?: number;
}

export interface ChainRow {
  series: string;
  bid: bigint;
  ask: bigint;
  mark: bigint;
  delta: number;
  gamma: number;
  fundingRateHourly: bigint;
  iv?: number;
}

export interface SignedQuote {
  quote: QuoteJson;
  /** base64 ed25519 signature over the domain-separated borsh digest. */
  signature: string;
}

export interface QuoteRequest {
  series: string;
  side: Side;
  /** Size units, 1e6 per contract. */
  size: bigint;
  taker: string;
}

/** `GET /attestation` (proposed, HANDOFF_GAURAV.md §4). TEE fields arrive with the Shade Agent (#34). */
export interface Attestation {
  agent_public_key: string;
  code_hash?: string;
  tee_quote_url?: string;
}

/** One row of `GET /funding/history`: a settlement the agent posted. All integers are decimal strings. */
export interface FundingHistoryJson {
  series: string;
  epoch: string;
  rate: string;
  mark: string;
  per_contract: string;
  index: string;
  ts_ns: string;
  tx_hash: string;
}

export interface FundingHistoryRow {
  series: string;
  epoch: bigint;
  mark: bigint;
  /** USDC micros per contract; positive means longs paid. */
  perContract: bigint;
  atMs: number;
}

/** `GET /hedge`: the agent's delta hedger (agent/twooptions_agent/hedger.py). */
export interface HedgeJson {
  enabled: boolean;
  venue?: string;
  network?: string;
  /** The exchange account that holds the hedge. The operator controls it; the contract does not. */
  account?: string;
  updated_ns?: string;
  /** Why the last pass failed, when it did. No order is sent while this is set. */
  error?: string | null;
  account_value?: string;
  underlyings: Record<string, {
    /** Perp position that offsets the vault's delta, in units of the underlying. Null when the contract's spot is stale. */
    target: number | null;
    position?: string;
    gap?: number | null;
    /** Half-width of the no-trade band, in units of the underlying: no order while |gap| is inside it. */
    band?: number | null;
    state?: HedgeState;
    reason?: string;
    venue_mid?: string | null;
    basis_bps?: number | null;
    entry_px?: string | null;
    unrealized_pnl?: string | null;
  }>;
  orders: {
    ts_ns: string; coin: string; side: 'buy' | 'sell'; size: string; limit_px: string; reduce_only: boolean;
    status: HedgeOrderStatus; filled?: string; avg_px?: string | null; detail?: string;
  }[];
  limits?: { deadband_usd: number; rehedge_move_bps?: number; max_order_usd: number; max_position_usd: number };
}

/** `balanced`: nothing to do. `trade`: an order went out this pass. `hold`: something is wrong, no order. */
export type HedgeState = 'balanced' | 'trade' | 'hold';
/** `unknown`: the request timed out, so the order may or may not have reached the venue. */
export type HedgeOrderStatus = 'filled' | 'rejected' | 'unknown';

export interface HedgeRow {
  underlying: string;
  target: number | null;
  /** Null when no hedger is running. */
  position: number | null;
  gap: number | null;
  /** The gap the hedger tolerates before trading; it widens with the book's gamma. */
  band: number | null;
  state: HedgeState | null;
  reason: string;
  venueMid: number | null;
  basisBps: number | null;
  unrealizedPnl: number | null;
}

export interface HedgeOrder {
  atMs: number;
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  filled: number;
  avgPx: number | null;
  reduceOnly: boolean;
  status: HedgeOrderStatus;
  detail: string;
}

export interface HedgeStatus {
  enabled: boolean;
  venue: string | null;
  network: string | null;
  account: string | null;
  updatedMs: number | null;
  error: string | null;
  /** Collateral in the exchange account, USD. */
  accountValue: number | null;
  deadbandUsd: number | null;
  /** The spot move whose delta drift the hedger tolerates, bps. */
  rehedgeMoveBps: number | null;
  rows: HedgeRow[];
  orders: HedgeOrder[];
}

/** The contract's core invariant: what it owes everyone equals the USDC it has taken in, net. */
export interface Solvency {
  ledgerTotal: bigint;
  netInflow: bigint;
}

/** `GET /health` (agent/twooptions_agent/server.py). */
export interface HealthJson {
  ok: boolean;
  paused: boolean;
  series: number;
  spot_age_s: Record<string, number>;
  keeper: {
    last_spot_post_ns: Record<string, string>;
    last_spot_hold: Record<string, string>;
    last_funding_epoch: Record<string, number>;
    liquidations: number;
    liquidated?: { account: string; liquidator?: string; tx_hash: string; ts_ns: string }[];
    /** The liquidation scan. Absent from agents older than the budgeted scan. */
    watch?: { accounts: number; with_positions: number; due: number; behind_s: number };
    errors: Record<string, string>;
  } | null;
  hedger?: boolean;
}

export interface AgentHealth {
  /** Null when this agent runs without a keeper (`--no-keeper`). */
  keeper: {
    /** When the keeper last sent a price, per underlying. */
    lastSpotPostMs: Record<string, number>;
    /** Why it is holding a price back instead of posting, per underlying. */
    spotHold: Record<string, string>;
    /** Liquidations since the agent started, and the most recent ones. */
    liquidations: number;
    liquidated: { account: string; txHash: string; atMs: number }[];
    /** The liquidation scan: accounts watched, how many hold positions, and how late the most overdue read of one of those is. Null when the agent does not report it. */
    watch: { accounts: number; withPositions: number; behindS: number } | null;
    /** The last failure of each job (`spot`, `funding`, `liquidations`) that has not succeeded since. */
    errors: Record<string, string>;
  } | null;
  hedger: boolean;
}

export interface Agent {
  readonly kind: 'http' | 'mock';
  /** False when quotes cannot pass the contract's signature check (mock agent against a real chain). */
  readonly canTrade: boolean;
  chain(): Promise<ChainRow[]>;
  quote(req: QuoteRequest): Promise<SignedQuote>;
  spot(): Promise<Partial<Record<Underlying, SpotPoint>>>;
  /** Null when the agent does not publish one. */
  attestation(): Promise<Attestation | null>;
  /** Past settlements, newest first. Only the quote server keeps them; RPC cannot list events. */
  fundingHistory?(limit: number): Promise<FundingHistoryRow[]>;
  /** Size limits the agent enforces on quotes. Null when it publishes none (older agent, demo). */
  limits?(): Promise<TradeLimits | null>;
  /** The delta hedger's state. Null when the agent is too old to report it. */
  hedge?(): Promise<HedgeStatus | null>;
  /** Liveness and keeper status, for the status page. */
  health?(): Promise<AgentHealth>;
}
