/** Minimal NEAR JSON-RPC client for free view calls. */

let nextId = 0;

export class RpcError extends Error {}

/** A failure worth trying another endpoint for: unreachable, rate-limited, or the provider is down. */
class Unavailable extends RpcError {}

/** Index of the endpoint that answered last, so a throttled one is not retried on every call. */
let preferred = 0;

/**
 * Free view call. `rpcUrls` are tried in turn, starting with the one that worked last: public
 * endpoints rate-limit (HTTP 429, which the browser reports as "Failed to fetch" because the
 * refusal carries no CORS headers), and one provider being throttled should not blank the app.
 */
export async function viewCall<T>(rpcUrls: string | readonly string[], accountId: string, method: string, args: object = {}): Promise<T> {
  const urls = typeof rpcUrls === 'string' ? [rpcUrls] : rpcUrls;
  let last: unknown;
  for (let i = 0; i < urls.length; i++) {
    const idx = (preferred + i) % urls.length;
    try {
      const out = await viewOnce<T>(urls[idx], accountId, method, args);
      preferred = idx;
      return out;
    } catch (e) {
      if (!(e instanceof Unavailable)) throw e;
      last = e;
    }
  }
  throw last;
}

async function viewOnce<T>(rpcUrl: string, accountId: string, method: string, args: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `twooptions-${++nextId}`,
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'optimistic',
          account_id: accountId,
          method_name: method,
          args_base64: btoa(JSON.stringify(args)),
        },
      }),
    });
  } catch (e) {
    throw new Unavailable(`${new URL(rpcUrl).host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 429 || res.status >= 500) throw new Unavailable(`${new URL(rpcUrl).host}: HTTP ${res.status}`);
  if (!res.ok) throw new RpcError(`RPC ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) {
    const cause = body.error.cause?.name ?? body.error.name ?? 'error';
    const info = body.error.data ?? body.error.message ?? '';
    throw new RpcError(`RPC ${method}: ${cause} ${typeof info === 'string' ? info : JSON.stringify(info)}`);
  }
  // A contract panic inside a view comes back as result.error, not a JSON-RPC error.
  if (body.result?.error) throw new RpcError(`${method}: ${body.result.error}`);
  const bytes = new Uint8Array(body.result.result as number[]);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** A JSON-RPC error with the node's own error object, e.g. `{ cause: { name: 'UNKNOWN_ACCESS_KEY' } }`. */
export class RpcCallError extends RpcError {
  constructor(message: string, readonly data: unknown) { super(message); }
}

/**
 * Any JSON-RPC method, with the same endpoint fallback as `viewCall`. Only failures where no
 * node answered are retried elsewhere; an error a node returns is final.
 */
export async function rpcCall<T>(rpcUrls: string | readonly string[], method: string, params: unknown): Promise<T> {
  const urls = typeof rpcUrls === 'string' ? [rpcUrls] : rpcUrls;
  let last: unknown;
  for (let i = 0; i < urls.length; i++) {
    const idx = (preferred + i) % urls.length;
    let res: Response;
    try {
      res = await fetch(urls[idx], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: `twooptions-${++nextId}`, method, params }),
      });
    } catch (e) {
      last = new Unavailable(`${new URL(urls[idx]).host}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) { last = new Unavailable(`${new URL(urls[idx]).host}: HTTP ${res.status}`); continue; }
    if (res.status === 408) throw new RpcCallError(`RPC ${method}: timed out`, { name: 'TIMEOUT_ERROR' });
    if (!res.ok) throw new RpcError(`RPC ${method}: HTTP ${res.status}`);
    const body = await res.json();
    preferred = idx;
    if (body.error) throw new RpcCallError(`RPC ${method}: ${JSON.stringify(body.error.data ?? body.error.cause ?? body.error)}`, body.error);
    return body.result as T;
  }
  throw last;
}
