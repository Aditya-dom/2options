/**
 * Polling that stops when nobody is looking. A hidden tab would otherwise keep making a dozen
 * RPC calls every few seconds for as long as it stays open, and free RPC endpoints throttle
 * exactly that.
 */

export interface PageVisibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (run, ms) => setInterval(run, ms),
  clear: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Call `load` now and every `ms` while the page is visible. While it is hidden nothing is
 * called; when it is shown again `load` runs at once, so what the user comes back to is fresh.
 * Returns a function that stops it.
 */
export function pollWhileVisible(load: () => void, ms: number, page: PageVisibility = document, timers: Timers = realTimers): () => void {
  let handle: unknown = null;
  const start = () => {
    if (handle != null) return;
    load();
    handle = timers.set(load, ms);
  };
  const stop = () => {
    if (handle == null) return;
    timers.clear(handle);
    handle = null;
  };
  const onChange = () => (page.hidden ? stop() : start());
  onChange();
  page.addEventListener('visibilitychange', onChange);
  return () => {
    stop();
    page.removeEventListener('visibilitychange', onChange);
  };
}
