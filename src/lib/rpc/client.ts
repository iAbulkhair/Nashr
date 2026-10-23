import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouter } from "./router";

/**
 * The typed browser client (rules 3421, 3424), as Supastarter's modules/shared/lib/orpc-client.ts and orpc-query-utils.ts:
 * one RPCLink to `{origin}/api/rpc`, the router's type imported as a type only (no server code in the bundle), and the
 * TanStack Query helpers over it. The address comes from `window.location.origin` when a call is made, never from an
 * environment variable; a call on the server throws before any request, so a server render fetches nothing.
 * Credentials are same-origin, and the proxy refuses a cross-site POST (src/lib/csrf.ts).
 */
export const RPC_CLIENT_PATH = "/api/rpc";

export type RpcClient = RouterClient<AppRouter>;

/** The browser's endpoint; throws on the server (Supastarter: "RPCLink is not allowed on the server side"). */
export function browserRpcUrl(): string {
  if (typeof window === "undefined") throw new Error("the RPC client runs in the browser only");
  return `${window.location.origin}${RPC_CLIENT_PATH}`;
}

/** A client over `url`; `fetchImpl` lets a test hand the request to the route module in-process. */
export function makeRpcClient(opts: { url: string | (() => string); fetchImpl?: typeof fetch } = { url: browserRpcUrl }): RpcClient {
  const send = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const link = new RPCLink({ url: opts.url, fetch: (request, init) => send(request, { ...init, credentials: "same-origin" }) });
  return createORPCClient(link);
}

/** The one browser client and its query helpers. Building them reads nothing; the first call reads the address. */
export const rpc: RpcClient = makeRpcClient();
export const orpc = createTanstackQueryUtils(rpc);

/** An oRPC failure as the legacy `{error, status}` a screen already maps: `data.error` when the server sent one. */
export function rpcFailure(e: unknown): { error: string; status: number } {
  if (e instanceof ORPCError) {
    const d = e.data as { error?: unknown } | undefined;
    return { error: typeof d?.error === "string" && d.error ? d.error : String(e.code).toLowerCase(), status: e.status };
  }
  return { error: "failed", status: 0 };
}
