/**
 * Picks the backend and agent from config, once.
 *
 * | VITE_CONTRACT_ID | VITE_AGENT_URL | backend          | agent                               |
 * |------------------|----------------|------------------|-------------------------------------|
 * | unset            | (ignored)      | in-browser demo  | local pricing, trades accepted      |
 * | set              | set            | chain            | Gaurav's quote server               |
 * | set              | unset          | chain            | local pricing, trading disabled     |
 */

import { HttpAgent, PricingAgent } from './backend/agent';
import { ChainBackend } from './backend/chain';
import { DemoBackend, DemoWorld, demoAgent } from './backend/demo';
import type { Agent, Backend } from './backend/types';
import { config, isDemo } from './lib/config';
import type { SpotPoint, Underlying } from './lib/contract';
import { DEFAULT_VOL } from './lib/pricing';
import { getWallet } from './hooks/useWallet';

export const world: DemoWorld | null = isDemo ? new DemoWorld() : null;

export const backend: Backend = world
  ? new DemoBackend(world)
  : new ChainBackend(config.contractId, config.usdcId, config.rpcUrls, getWallet);

export const agent: Agent = world
  ? demoAgent(world)
  : config.agentUrl
    ? new HttpAgent(config.agentUrl)
    : new PricingAgent({
        series: () => backend.listSeries(),
        params: () => backend.getParams(),
        vol: u => DEFAULT_VOL[u],
        spots: async () => {
          const unique = [...new Set((await backend.listSeries()).map(s => s.underlying))];
          const pts = await Promise.all(unique.map(u => backend.getSpot(u)));
          const out: Partial<Record<Underlying, SpotPoint>> = {};
          unique.forEach((u, i) => { if (pts[i]) out[u] = pts[i]!; });
          return out;
        },
      }, false);
