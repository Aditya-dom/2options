/**
 * Public NEAR RPC endpoints, in the order the app tries them. Free endpoints rate-limit and
 * stall, each on its own schedule, so the app keeps several and moves to the next when one
 * does not answer. Order: fastest and most tolerant of bursts first, measured from a browser
 * (CORS allowed by all of them); the slow ones are a last resort.
 */
import type { NetworkId } from './config';

export const DEFAULT_RPCS: Record<NetworkId, readonly string[]> = {
  testnet: [
    'https://test.rpc.fastnear.com',
    'https://near-testnet.drpc.org',
    'https://api.zan.top/near-testnet',
    'https://testnet-rpc.intea.rs',
    'https://rpc.testnet.near.org',
  ],
  mainnet: [
    'https://free.rpc.fastnear.com',
    'https://near.drpc.org',
    'https://api.zan.top/near-mainnet',
    'https://rpc.intea.rs',
    'https://rpc.shitzuapes.xyz',
  ],
};

/**
 * The endpoints to use: those configured (`VITE_NEAR_RPC_URL`, comma separated, in order of
 * preference) followed by the defaults, each once. Configuring one endpoint therefore puts it
 * first without giving up the fallbacks.
 */
export function rpcList(configured: string, network: NetworkId): string[] {
  const mine = configured.split(',').map(u => u.trim().replace(/\/+$/, '')).filter(u => /^https?:\/\//.test(u));
  return [...new Set([...mine, ...DEFAULT_RPCS[network]])];
}
