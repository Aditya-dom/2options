import { useSyncExternalStore } from 'react';

/** The app's screens. Each has an address: `#/` is the landing page, `#/trade` the desk, and so on. */
export const TABS = [
  { id: 'trade', label: 'TRADE' },
  { id: 'strategy', label: 'STRATEGY' },
  { id: 'vault', label: 'VAULT' },
  { id: 'funding', label: 'FUNDING' },
] as const;

export type Tab = (typeof TABS)[number]['id'];
export type Route = Tab | 'landing';

export const href = (route: Route) => (route === 'landing' ? '#/' : `#/${route}`);

export function parseRoute(hash: string): Route {
  const id = hash.replace(/^#\/?/, '');
  return TABS.find(t => t.id === id)?.id ?? 'landing';
}

export const goTo = (route: Route) => { window.location.hash = href(route); };

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export const useRoute = (): Route => useSyncExternalStore(subscribe, () => parseRoute(window.location.hash));
