/**
 * Runtime configuration from Vite env. With no contract id the app runs in demo mode against
 * an in-browser simulation; with one, every number comes from chain and the agent.
 */

export type NetworkId = 'testnet' | 'mainnet';

const env = import.meta.env;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const network = (str(env.VITE_NEAR_NETWORK) || 'testnet') as NetworkId;
const DEFAULT_RPC: Record<NetworkId, string> = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};
/** Tried when the primary endpoint is unreachable or rate-limits. */
const FALLBACK_RPC: Record<NetworkId, string> = {
  testnet: 'https://near-testnet.drpc.org',
  mainnet: 'https://near.drpc.org',
};
const EXPLORER: Record<NetworkId, string> = {
  testnet: 'https://testnet.nearblocks.io',
  mainnet: 'https://nearblocks.io',
};

export const config = {
  network,
  contractId: str(env.VITE_CONTRACT_ID),
  usdcId: str(env.VITE_USDC_ID),
  /** `same-origin`: the agent serves this app (one container), so it is wherever the page is. */
  agentUrl: (str(env.VITE_AGENT_URL) === 'same-origin' && typeof window !== 'undefined'
    ? window.location.origin
    : str(env.VITE_AGENT_URL)).replace(/\/+$/, ''),
  /** Optional `ed25519:…` key to verify quotes against; otherwise taken from the agent's /attestation. */
  agentPublicKey: str(env.VITE_AGENT_PUBLIC_KEY),
  rpcUrl: str(env.VITE_NEAR_RPC_URL) || DEFAULT_RPC[network],
  /** Read endpoints in order of preference: the configured one, then a second provider. */
  rpcUrls: [...new Set([str(env.VITE_NEAR_RPC_URL) || DEFAULT_RPC[network], FALLBACK_RPC[network]])],
  explorerUrl: EXPLORER[network],
};

export const isDemo = config.contractId === '';

/** Fail fast on a half-configured deploy instead of failing on the first transaction. */
export function configErrors(): string[] {
  const errs: string[] = [];
  if (network !== 'testnet' && network !== 'mainnet') errs.push(`VITE_NEAR_NETWORK must be testnet or mainnet, got "${network}"`);
  if (!isDemo && !config.usdcId) errs.push('VITE_CONTRACT_ID is set but VITE_USDC_ID is not');
  if (config.agentUrl && !/^https?:\/\//.test(config.agentUrl)) errs.push('VITE_AGENT_URL must be an http(s) URL');
  if (config.agentPublicKey && !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.agentPublicKey)) {
    errs.push('VITE_AGENT_PUBLIC_KEY must look like ed25519:<base58>');
  }
  return errs;
}

export const txUrl = (hash: string) => `${config.explorerUrl}/txns/${hash}`;
