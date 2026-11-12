import type { Wallet, WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import { create } from 'zustand';
import { ACCESS_KEY_METHODS } from '../backend/chain';
import { forgetTradingKeys } from '../backend/tradingKey';
import { DEMO_ACCOUNT } from '../backend/demo';
import { config, isDemo } from '../lib/config';

interface WalletStore {
  accountId: string | null;
  ready: boolean;
  initError: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
}

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;

export const useWallet = create<WalletStore>(set => ({
  accountId: null,
  ready: isDemo,
  initError: null,
  signIn: () => {
    if (isDemo) set({ accountId: DEMO_ACCOUNT });
    else modal?.show();
  },
  signOut: async () => {
    if (!isDemo && selector) await (await selector.wallet()).signOut();
    forgetTradingKeys();
    set({ accountId: null });
  },
}));

/**
 * Wallet Selector with Meteor, HOT and MyNearWallet, loaded lazily so the demo never pulls in
 * wallet SDKs and a failing SDK surfaces as `initError` instead of a blank page.
 *
 * Signing in creates a function-call access key for the zero-deposit contract methods, so
 * trades go through without a popup inside the 10 s quote window. Deposits attach 1 yocto and
 * always ask the wallet.
 */
export async function initWallet(): Promise<void> {
  if (isDemo || selector) return;
  try {
    // Wallet SDKs read Node globals at import time.
    const { Buffer } = await import('buffer');
    const g = globalThis as { Buffer?: unknown; process?: unknown };
    g.Buffer ??= Buffer;
    g.process ??= { env: {}, browser: true, version: '', versions: {}, nextTick: (fn: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => fn(...a)) };
    const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupHotWallet }, { setupMyNearWallet }] = await Promise.all([
      import('@near-wallet-selector/core'),
      import('@near-wallet-selector/modal-ui'),
      import('@near-wallet-selector/meteor-wallet'),
      import('@near-wallet-selector/hot-wallet'),
      import('@near-wallet-selector/my-near-wallet'),
      import('@near-wallet-selector/modal-ui/styles.css'),
    ]);
    selector = await setupWalletSelector({
      network: config.network,
      modules: [setupMeteorWallet(), setupHotWallet(), setupMyNearWallet()],
      createAccessKeyFor: { contractId: config.contractId, methodNames: ACCESS_KEY_METHODS },
    });
    modal = setupModal(selector, {
      contractId: config.contractId,
      methodNames: ACCESS_KEY_METHODS,
      theme: 'dark',
      description: '2options trades are signed with a limited key that can only call trade, withdraw and LP methods on the 2options contract.',
    });
    useWallet.setState({ accountId: selector.store.getState().accounts.find(a => a.active)?.accountId ?? null, ready: true });
    selector.store.observable.subscribe(state => {
      useWallet.setState({ accountId: state.accounts.find(a => a.active)?.accountId ?? null });
    });
  } catch (e) {
    useWallet.setState({ ready: true, initError: e instanceof Error ? e.message : String(e) });
  }
}

export async function getWallet(): Promise<Wallet> {
  if (!selector) throw new Error('wallet selector is not initialised');
  return selector.wallet();
}
