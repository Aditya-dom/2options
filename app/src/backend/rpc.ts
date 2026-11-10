/** Minimal NEAR JSON-RPC client for free view calls. */

let nextId = 0;

export class RpcError extends Error {}

export async function viewCall<T>(rpcUrl: string, accountId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `perennia-${++nextId}`,
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
