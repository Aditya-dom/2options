/** Minimal NEAR JSON-RPC client for free view calls. */

let nextId = 0;

export class RpcError extends Error {}

/** A failure worth trying another endpoint for: unreachable, rate-limited, or the provider is down. */
class Unavailable extends RpcError {}

/**
 * Endpoints that failed to answer, and until when they are passed over. The list is in order
 * of preference, fastest first: an endpoint that fails rests and the next one serves, and when
 * its rest is over it leads again. Staying with "whichever answered last" instead leaves every
 * request on a slow last resort for as long as that one keeps answering.
 */
const resting = new Map<string, number>();
const REST_MS = 30_000;

/** `urls` with the resting ones moved to the back: a last resort, not an omission. */
export function inOrder(urls: readonly string[], now = Date.now()): string[] {
  const ready = urls.filter(u => (resting.get(u) ?? 0) <= now);
  return [...ready, ...urls.filter(u => !ready.includes(u))];
}
const rest = (url: string) => { resting.set(url, Date.now() + REST_MS); };

/** Forget which endpoints are resting (tests). */
export const resetEndpoints = () => resting.clear();

/** How long one endpoint gets to answer a read before the next is tried. Healthy ones take well under a second. */
const READ_TIMEOUT_MS = 4_000;
/** A broadcast waits for the transaction to run, so it gets longer. */
const SEND_TIMEOUT_MS = 30_000;

/**
 * `fetch` that gives up after `ms`. Without it one stalled provider would hold a request, and
 * with it the app's whole polling loop, for as long as the browser cared to wait.
 */
async function post(url: string, body: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Free view call. `rpcUrls` are tried in order, the ones that failed recently last: public
 * endpoints rate-limit (HTTP 429, which the browser reports as "Failed to fetch" because the
 * refusal carries no CORS headers), and one provider being throttled should not blank the app.
 */
export async function viewCall<T>(rpcUrls: string | readonly string[], accountId: string, method: string, args: object = {}): Promise<T> {
  const urls = typeof rpcUrls === 'string' ? [rpcUrls] : rpcUrls;
  let last: unknown;
  for (const url of inOrder(urls)) {
    try {
      const out = await viewOnce<T>(url, accountId, method, args);
      resting.delete(url);
      return out;
    } catch (e) {
      if (!(e instanceof Unavailable)) throw e;
      rest(url);
      last = e;
    }
  }
  throw last;
}

async function viewOnce<T>(rpcUrl: string, accountId: string, method: string, args: object): Promise<T> {
  let res: Response;
  try {
    res = await post(rpcUrl, JSON.stringify({
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
    }), READ_TIMEOUT_MS);
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
  for (const url of inOrder(urls)) {
    let res: Response;
    try {
      // A transaction sent twice is one transaction (same hash), so trying the next endpoint
      // after a stalled broadcast is safe.
      const wait = method === 'send_tx' || method === 'tx' ? SEND_TIMEOUT_MS : READ_TIMEOUT_MS;
      res = await post(url, JSON.stringify({ jsonrpc: '2.0', id: `twooptions-${++nextId}`, method, params }), wait);
    } catch (e) {
      last = new Unavailable(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
      rest(url);
      continue;
    }
    if (res.status === 429 || res.status >= 500) { last = new Unavailable(`${new URL(url).host}: HTTP ${res.status}`); rest(url); continue; }
    if (res.status === 408) throw new RpcCallError(`RPC ${method}: timed out`, { name: 'TIMEOUT_ERROR' });
    if (!res.ok) throw new RpcError(`RPC ${method}: HTTP ${res.status}`);
    const body = await res.json();
    resting.delete(url);
    if (body.error) throw new RpcCallError(`RPC ${method}: ${JSON.stringify(body.error.data ?? body.error.cause ?? body.error)}`, body.error);
    return body.result as T;
  }
  throw last;
}
