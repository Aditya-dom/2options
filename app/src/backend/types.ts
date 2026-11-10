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
  | { kind: 'register_usdc' };

export interface CallResult {
  /** Final transaction hash when the wallet returned one (redirect wallets do not). */
  txHash: string | null;
  /** Contract events seen in the receipts, e.g. `WithdrawRefunded`. */
  events: string[];
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

  submit(accountId: string, call: Call): Promise<CallResult>;
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
}

export interface ChainRow {
  series: string;
  bid: bigint;
  ask: bigint;
  mark: bigint;
  delta: number;
  gamma: number;
  fundingRateHourly: bigint;
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

export interface Agent {
  readonly kind: 'http' | 'mock';
  /** False when quotes cannot pass the contract's signature check (mock agent against a real chain). */
  readonly canTrade: boolean;
  chain(): Promise<ChainRow[]>;
  quote(req: QuoteRequest): Promise<SignedQuote>;
  spot(): Promise<Partial<Record<Underlying, SpotPoint>>>;
  /** Null when the agent does not publish one. */
  attestation(): Promise<Attestation | null>;
}
