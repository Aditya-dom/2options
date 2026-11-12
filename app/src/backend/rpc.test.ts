import { afterEach, expect, test } from 'bun:test';
import { RpcError, viewCall } from './rpc';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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
