/**
 * What the app can say about the agent that signs its quotes:
 *
 * 1. Which key it signs with (VITE_AGENT_PUBLIC_KEY, else the agent's /attestation).
 * 2. Whether the contract accepts that key (`is_agent_key`).
 * 3. Whether each quote received is actually signed by it (checked in the browser).
 * 4. The TEE attestation (code hash, quote) when the agent runs in a TEE.
 */

import { create } from 'zustand';
import type { Attestation, SignedQuote } from '../backend/types';
import { config, isDemo } from '../lib/config';
import { verifyQuote } from '../lib/wire';
import { agent, backend } from '../services';

export interface QuoteCheck { ok: boolean; atMs: number; series: string }

interface TrustState {
  key: string | null;
  keySource: 'config' | 'attestation' | null;
  registered: boolean | null;
  attestation: Attestation | null;
  lastCheck: QuoteCheck | null;
  error: string | null;
  loaded: boolean;
}

export const useAgentTrust = create<TrustState>(() => ({
  key: null, keySource: null, registered: null, attestation: null, lastCheck: null, error: null, loaded: isDemo,
}));

export async function loadAgentTrust(): Promise<void> {
  if (isDemo || agent.kind !== 'http') { useAgentTrust.setState({ loaded: true }); return; }
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let error: string | null = null;
  const attestation = await agent.attestation().catch(e => { error = `attestation: ${msg(e)}`; return null; });
  const key = config.agentPublicKey || attestation?.agent_public_key || null;
  // A failed registration check leaves `registered` unknown; it must not hide the key itself.
  const registered = key ? await backend.isAgentKey(key).catch(e => { error = `is_agent_key: ${msg(e)}`; return null; }) : null;
  useAgentTrust.setState({
    key, keySource: config.agentPublicKey ? 'config' : key ? 'attestation' : null,
    registered, attestation, loaded: true, error,
  });
}

/**
 * Check a quote against the known agent key. Returns false only for a signature that does not
 * match; with no key known it returns true and the contract remains the only check.
 */
export function checkQuote(q: SignedQuote): boolean {
  const { key } = useAgentTrust.getState();
  if (!key || agent.kind !== 'http') return true;
  const ok = verifyQuote(backend.contractId, q.quote, q.signature, key);
  useAgentTrust.setState({ lastCheck: { ok, atMs: Date.now(), series: q.quote.series } });
  return ok;
}

export const BAD_SIGNATURE = 'This quote is not signed by the registered agent key, so it was not submitted.';
