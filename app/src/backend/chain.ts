/**
 * Real backend: free views over JSON-RPC, state changes through the connected wallet.
 */

import { actionCreators } from '@near-js/transactions';
import type { FinalExecutionOutcome, Wallet } from '@near-wallet-selector/core';
import {
  parseAccount, parseLpClaim, parseParams, parseSeries, parseSpot, parseVault,
  type AccountViewJson, type ParamsJson, type SeriesViewJson, type Underlying, type VaultViewJson,
} from '../lib/contract';
import { big } from '../lib/units';
import { viewCall } from './rpc';
import type { Backend, Call, CallResult } from './types';

const TGAS = 1_000_000_000_000n;
/** ft_transfer_call forwards to ft_on_transfer; the handoff says start at 100 TGas. */
const GAS_DEPOSIT = 100n * TGAS;
/** withdraw / lp_claim chain an ft_transfer (30 TGas) and a callback (15 TGas). */
const GAS_PAYOUT = 100n * TGAS;
/** trade iterates every series for the vault risk check (up to 32). */
const GAS_TRADE = 150n * TGAS;
const GAS_SIMPLE = 50n * TGAS;
const ONE_YOCTO = 1n;
/** Per-transaction prepaid gas limit, shared across a batch's trade() actions. */
const MAX_TX_GAS = 300n * TGAS;
/** ~75 TGas per leg; trade() gas is not measured yet (#18), so stay conservative. */
export const MAX_BATCH_LEGS = 4;

/** Zero-deposit methods a limited access key may call, so trades sign without a wallet popup. */
export const ACCESS_KEY_METHODS = ['trade', 'withdraw', 'lp_request_redeem', 'lp_claim'];

export class ChainBackend implements Backend {
  readonly mode = 'chain' as const;

  constructor(
    readonly contractId: string,
    readonly usdcId: string,
    private readonly rpcUrl: string | readonly string[],
    private readonly wallet: () => Promise<Wallet>,
  ) {}

  private view<T>(method: string, args: object = {}, account = this.contractId): Promise<T> {
    return viewCall<T>(this.rpcUrl, account, method, args);
  }

  async getParams() { return parseParams(await this.view<ParamsJson>('get_params')); }
  async listSeries() { return (await this.view<SeriesViewJson[]>('list_series')).map(parseSeries); }
  async getSpot(u: Underlying) { return parseSpot(await this.view<[string, string] | null>('get_spot', { underlying: u })); }
  async getVault() { return parseVault(await this.view<VaultViewJson>('get_vault')); }
  isPaused() { return this.view<boolean>('is_paused'); }

  async getAccount(accountId: string) {
    const j = await this.view<AccountViewJson | null>('get_account', { account_id: accountId });
    return j && parseAccount(j);
  }

  async getLpShares(accountId: string) { return big(await this.view<string>('get_lp_shares', { account_id: accountId })); }
  async getLpClaim(accountId: string) {
    return parseLpClaim(await this.view<[string, string] | null>('get_lp_claim', { account_id: accountId }));
  }

  async usdcBalance(accountId: string) {
    return big(await this.view<string>('ft_balance_of', { account_id: accountId }, this.usdcId));
  }

  async usdcRegistered(accountId: string) {
    return (await this.view<object | null>('storage_balance_of', { account_id: accountId }, this.usdcId)) != null;
  }

  isAgentKey(key: string) { return this.view<boolean>('is_agent_key', { key }); }

  async submit(accountId: string, call: Call): Promise<CallResult> {
    const { receiverId, actions } = await this.toTx(accountId, call);
    const wallet = await this.wallet();
    const outcome = await wallet.signAndSendTransaction({ signerId: accountId, receiverId, actions });
    return readOutcome(outcome);
  }

  private async toTx(accountId: string, call: Call) {
    if (call.kind === 'trade_batch') {
      // One receipt: if any trade() panics, every leg reverts. Function-call access keys can only
      // sign single-action transactions, so a batch needs one confirmation in the wallet.
      if (call.legs.length > MAX_BATCH_LEGS) throw new Error(`at most ${MAX_BATCH_LEGS} legs per transaction`);
      const gas = MAX_TX_GAS / BigInt(call.legs.length);
      return {
        receiverId: this.contractId,
        actions: call.legs.map(l => actionCreators.functionCall('trade', { quote: l.quote, signature: l.signature }, gas < GAS_TRADE ? gas : GAS_TRADE, 0n)),
      };
    }
    const { receiverId, action } = await this.toAction(accountId, call);
    return { receiverId, actions: [action] };
  }

  private async toAction(accountId: string, call: Exclude<Call, { kind: 'trade_batch' }>) {
    const fc = actionCreators.functionCall;
    switch (call.kind) {
      case 'deposit':
      case 'lp_deposit':
        return {
          receiverId: this.usdcId,
          action: fc('ft_transfer_call', {
            receiver_id: this.contractId,
            amount: call.amount.toString(),
            msg: call.kind === 'deposit' ? 'deposit' : 'lp',
          }, GAS_DEPOSIT, ONE_YOCTO),
        };
      case 'withdraw':
        return { receiverId: this.contractId, action: fc('withdraw', { amount: call.amount.toString() }, GAS_PAYOUT, 0n) };
      case 'trade':
        return { receiverId: this.contractId, action: fc('trade', { quote: call.quote, signature: call.signature }, GAS_TRADE, 0n) };
      case 'lp_request_redeem':
        return { receiverId: this.contractId, action: fc('lp_request_redeem', { shares: call.shares.toString() }, GAS_SIMPLE, 0n) };
      case 'lp_claim':
        return { receiverId: this.contractId, action: fc('lp_claim', {}, GAS_PAYOUT, 0n) };
      case 'register_usdc': {
        const bounds = await this.view<{ min: string }>('storage_balance_bounds', {}, this.usdcId);
        return {
          receiverId: this.usdcId,
          action: fc('storage_deposit', { account_id: accountId, registration_only: true }, GAS_SIMPLE, big(bounds.min)),
        };
      }
    }
  }
}

/**
 * A failed ft_on_transfer does not fail the outer ft_transfer_call (the token refunds instead),
 * so every receipt is checked, not just the transaction status.
 */
export function readOutcome(outcome: FinalExecutionOutcome | void): CallResult {
  if (!outcome) return { txHash: null, events: [] };
  const events: string[] = [];
  const failures: string[] = [];
  const status = outcome.status as { Failure?: unknown } | string;
  if (typeof status === 'object' && status.Failure) failures.push(JSON.stringify(status.Failure));
  for (const r of outcome.receipts_outcome) {
    const st = r.outcome.status as { Failure?: unknown } | string;
    if (typeof st === 'object' && st.Failure) failures.push(JSON.stringify(st.Failure));
    for (const log of r.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (ev.standard === 'twooptions') events.push(ev.event);
      } catch { /* not ours */ }
    }
  }
  const txHash = outcome.transaction_outcome?.id ?? null;
  if (failures.length) {
    const err = new Error(failures[0]) as Error & { txHash?: string | null; events?: string[] };
    err.txHash = txHash;
    err.events = events;
    throw err;
  }
  return { txHash, events };
}
