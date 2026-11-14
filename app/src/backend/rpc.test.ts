import { afterEach, expect, test } from 'bun:test';
import { inOrder, resetEndpoints, RpcError, viewCall } from './rpc';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetEndpoints(); });

const ok = (value: unknown) => new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }));
const serve = (handler: (url: string) => Response | Promise<Response>) => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => { seen.push(url); return handler(url); }) as unknown as typeof fetch;
  return seen;
};

test('falls back when the first endpoint is rate-limited or unreachable, then sticks with the one that worked', async () => {
  const seen = serve(url => {
    if (url.includes('a.example')) throw new TypeError('Failed to fetch');
    return ok(true);
  });
  const urls = ['https://a.example', 'https://b.example'];
  expect(await viewCall<boolean>(urls, 'c.testnet', 'is_paused')).toBe(true);
  expect(await viewCall<boolean>(urls, 'c.testnet', 'is_paused')).toBe(true);
  expect(seen).toEqual(['https://a.example', 'https://b.example', 'https://b.example']);

  serve(url => (url.includes('b.example') ? new Response('', { status: 429 }) : ok(7)));
  expect(await viewCall<number>(urls, 'c.testnet', 'x')).toBe(7);
});

test('reports the failure when every endpoint is unavailable', async () => {
  serve(() => new Response('', { status: 429 }));
  await expect(viewCall(['https://a.example', 'https://b.example'], 'c.testnet', 'x')).rejects.toThrow(/HTTP 429/);
});

test('a contract error is not retried on another endpoint', async () => {
  const seen = serve(() => new Response(JSON.stringify({ result: { error: 'wasm execution failed' } })));
  await expect(viewCall(['https://a.example', 'https://b.example'], 'c.testnet', 'x')).rejects.toBeInstanceOf(RpcError);
  expect(seen.length).toBe(1);
});

test('an endpoint that never answers is given up on, and the next one is asked', async () => {
  const realSetTimeout = globalThis.setTimeout;
  // Let the 8 s limit pass at once: the timer that aborts the stalled request fires immediately.
  globalThis.setTimeout = ((run: () => void) => realSetTimeout(run, 0)) as unknown as typeof setTimeout;
  const seen: string[] = [];
  globalThis.fetch = ((url: string, init: { signal: AbortSignal }) => {
    seen.push(url);
    if (url.includes('b.example')) return Promise.resolve(ok('answered'));
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }) as unknown as typeof fetch;
  try {
    expect(await viewCall<string>(['https://a.example', 'https://b.example'], 'c.testnet', 'x')).toBe('answered');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  expect(seen.slice(-2)).toEqual(['https://a.example', 'https://b.example']);
});

test('a failed endpoint rests, then leads again: the app does not stay on a slow last resort', async () => {
  const urls = ['https://fast.example', 'https://slow.example'];
  let fastUp = false;
  const seen = serve(url => (url.includes('fast.example') && !fastUp ? new Response('', { status: 429 }) : ok(1)));
  await viewCall(urls, 'c.testnet', 'x'); // fast refuses, slow serves
  fastUp = true;
  await viewCall(urls, 'c.testnet', 'x'); // fast is resting
  expect(seen).toEqual(['https://fast.example', 'https://slow.example', 'https://slow.example']);
  expect(inOrder(urls)).toEqual(['https://slow.example', 'https://fast.example']);
  expect(inOrder(urls, Date.now() + 31_000)).toEqual(urls); // half a minute on, it is first again
});
