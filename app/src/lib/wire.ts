/**
 * Client-side check of agent signatures, using the contract's wire format (contracts/README.md):
 *
 *   digest    = sha256(domain || u32_le(len(contract_id)) || contract_id || borsh(message))
 *   signature = ed25519(agent key, digest)
 *
 * Tested against agent/tests/fixtures/wire_vectors.json, generated from the contract's own types
 * (contracts/twooptions/examples/wire_vectors.rs). The contract re-checks every signature; this
 * lets the UI show that a quote really comes from the registered agent before the user signs.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import type { QuoteJson } from './contract';

export const QUOTE_DOMAIN = 'twooptions:quote:v1';
export const SPOT_DOMAIN = 'twooptions:spot:v1';
export const FUNDING_DOMAIN = 'twooptions:funding:v1';

const UNDERLYING_INDEX: Record<string, number> = { BTC: 0, ETH: 1, SOL: 2, NEAR: 3 };
const SIDE_INDEX: Record<string, number> = { Buy: 0, Sell: 1 };
const enc = new TextEncoder();

function le(v: bigint, bytes: number, signed = false): Uint8Array {
  const bits = BigInt(bytes * 8);
  const min = signed ? -(1n << (bits - 1n)) : 0n;
  const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (v < min || v > max) throw new Error(`${v} does not fit in ${signed ? 'i' : 'u'}${bits}`);
  let x = v < 0n ? (1n << bits) + v : v;
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

const str = (s: string) => { const b = enc.encode(s); return concat(le(BigInt(b.length), 4), b); };
const u8 = (n: number) => Uint8Array.of(n);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const borshQuote = (q: QuoteJson) => concat(
  str(q.series), str(q.taker), u8(SIDE_INDEX[q.side]),
  le(BigInt(q.size), 16), le(BigInt(q.price), 16), le(BigInt(q.nonce), 8), le(BigInt(q.expiry_ns), 8),
);

export const borshSpot = (s: { underlying: string; price: string; ts_ns: string; seq: string }) => concat(
  u8(UNDERLYING_INDEX[s.underlying]), le(BigInt(s.price), 16), le(BigInt(s.ts_ns), 8), le(BigInt(s.seq), 8),
);

export const borshFunding = (f: { series: string; epoch: string; rate: string; mark: string }) => concat(
  str(f.series), le(BigInt(f.epoch), 8), le(BigInt(f.rate), 16, true), le(BigInt(f.mark), 16),
);

export function digest(domain: string, contractId: string, body: Uint8Array): Uint8Array {
  const cid = enc.encode(contractId);
  return sha256(concat(enc.encode(domain), le(BigInt(cid.length), 4), cid, body));
}

/** `ed25519:<base58>` (NEAR's PublicKey string) → 32 raw bytes. */
export function parseEd25519Key(key: string): Uint8Array {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(key.trim());
  if (!m) throw new Error('expected an ed25519:<base58> public key');
  const raw = base58.decode(m[1]);
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return raw;
}

const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** True when `signature` (base64) is the agent key's signature over this quote for this contract. */
export function verifyQuote(contractId: string, quote: QuoteJson, signature: string, agentKey: string): boolean {
  try {
    return ed25519.verify(b64(signature), digest(QUOTE_DOMAIN, contractId, borshQuote(quote)), parseEd25519Key(agentKey));
  } catch {
    return false;
  }
}
