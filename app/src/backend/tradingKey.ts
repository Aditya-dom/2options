/**
 * The app's own trading key, so buys and sells need no wallet popup.
 *
 * The first time it is needed, the app makes an ed25519 key in the browser and asks the wallet,
 * once, to add it to the user's account as a function-call key. NEAR then lets that key call only
 * the listed zero-deposit methods on the 2options contract (`trade`, `withdraw`, LP redeem and
 * claim) and spend at most ALLOWANCE on gas. It cannot transfer NEAR or tokens, call any other
 * contract, or attach a deposit; `withdraw` pays only the account itself. After that, the app
 * signs those calls itself and sends them straight to the RPC.
 *
 * Deposits (they attach 1 yoctoNEAR) and multi-leg strategies (several actions in one
 * transaction) still go through the wallet: a function-call key can do neither.
 *
 * The secret stays in this browser's storage. Signing out forgets it; the key on the account is
 * then unusable, and the user can delete it from their wallet.
 */

import { PublicKey } from '@near-js/crypto';
import {
  actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction, type Action,
} from '@near-js/transactions';
import type { FinalExecutionOutcome, Wallet } from '@near-wallet-selector/core';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import { RpcCallError, rpcCall } from './rpc';

/**
 * Gas budget for the key, yoctoNEAR: 1 NEAR. NEAR charges a function-call key's budget for the
 * gas a transaction reserves (150 TGas for a trade), not what it burns, so this lasts about thirty
 * trades. Below MIN_LEFT the app adds a fresh key, which is one more wallet confirmation.
 */
export const ALLOWANCE = 1_000_000_000_000_000_000_000_000n;
const MIN_LEFT = 50_000_000_000_000_000_000_000n;
const PREFIX = 'twooptions-trading-key';

interface Stored { seed: string; publicKey: string }

const storageKey = (network: string, contractId: string, accountId: string) => `${PREFIX}:${network}:${contractId}:${accountId}`;

export function publicKeyOf(seed: Uint8Array): string {
  return `ed25519:${base58.encode(ed25519.getPublicKey(seed))}`;
}

function load(k: string): { seed: Uint8Array; publicKey: string } | null {
  try {
    const s = JSON.parse(localStorage.getItem(k) ?? 'null') as Stored | null;
    if (!s) return null;
    const seed = base58.decode(s.seed);
    return seed.length === 32 && publicKeyOf(seed) === s.publicKey ? { seed, publicKey: s.publicKey } : null;
  } catch { return null; }
}

/** Forget every trading key this browser holds (on sign-out). */
export function forgetTradingKeys() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

interface AccessKeyView {
  nonce: number | string;
  block_hash: string;
  permission: 'FullAccess' | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } };
}

/** The key's nonce and a recent block hash, or null if the account does not have it (or it is not ours). */
async function accessKey(rpc: readonly string[], accountId: string, publicKey: string, contractId: string) {
  let v: AccessKeyView & { error?: string };
  try {
    v = await rpcCall<AccessKeyView & { error?: string }>(rpc, 'query', {
      request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey,
    });
  } catch (e) {
    if (e instanceof RpcCallError && /UNKNOWN_ACCESS_KEY|does not exist/.test(e.message)) return null;
    throw e;
  }
  if (v.error || typeof v.permission !== 'object' || v.permission.FunctionCall.receiver_id !== contractId) return null;
  const left = v.permission.FunctionCall.allowance;
  return { nonce: BigInt(v.nonce), blockHash: v.block_hash, allowance: left == null ? null : BigInt(left) };
}

export class TradingKey {
  constructor(
    private readonly rpc: readonly string[],
    private readonly network: string,
    private readonly contractId: string,
    private readonly methods: string[],
  ) {}

  /** The usable key for `accountId`, adding one through the wallet (one confirmation) if needed. */
  async ensure(accountId: string, wallet: () => Promise<Wallet>): Promise<{ seed: Uint8Array; publicKey: string }> {
    const k = storageKey(this.network, this.contractId, accountId);
    const have = load(k);
    if (have) {
      const ak = await accessKey(this.rpc, accountId, have.publicKey, this.contractId);
      // Still on the account, with gas budget left: use it. Otherwise add a fresh one.
      if (ak && (ak.allowance == null || ak.allowance >= MIN_LEFT)) return have;
    }

    const seed = ed25519.utils.randomPrivateKey();
    const publicKey = publicKeyOf(seed);
    const w = await wallet();
    await w.signAndSendTransaction({
      signerId: accountId,
      receiverId: accountId,
      actions: [actionCreators.addKey(PublicKey.fromString(publicKey), actionCreators.functionCallAccessKey(this.contractId, this.methods, ALLOWANCE))],
    });
    try { localStorage.setItem(k, JSON.stringify({ seed: base58.encode(seed), publicKey })); } catch { /* used for this session only */ }
    return { seed, publicKey };
  }

  /** Sign with the trading key and send; waits until every receipt has executed. */
  async send(accountId: string, key: { seed: Uint8Array; publicKey: string }, receiverId: string, actions: Action[]): Promise<FinalExecutionOutcome> {
    const ak = await accessKey(this.rpc, accountId, key.publicKey, this.contractId);
    if (!ak) throw new Error('trading key is not on the account; trade again to add a new one');
    const tx = createTransaction(accountId, PublicKey.fromString(key.publicKey), receiverId, ak.nonce + 1n, actions, base58.decode(ak.blockHash));
    const hash = sha256(encodeTransaction(tx));
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: ed25519.sign(hash, key.seed) }) });
    const b64 = btoa(String.fromCharCode(...signed.encode()));
    try {
      return await rpcCall<FinalExecutionOutcome>(this.rpc, 'send_tx', { signed_tx_base64: b64, wait_until: 'EXECUTED_OPTIMISTIC' });
    } catch (e) {
      // A node that times out waiting has usually accepted the transaction: ask for its outcome.
      if (!(e instanceof RpcCallError) || !/timeout|timed out/i.test(e.message)) throw e;
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1_000));
        try {
          return await rpcCall<FinalExecutionOutcome>(this.rpc, 'tx', { tx_hash: base58.encode(hash), sender_account_id: accountId, wait_until: 'EXECUTED_OPTIMISTIC' });
        } catch { /* not yet known */ }
      }
      throw e;
    }
  }
}
