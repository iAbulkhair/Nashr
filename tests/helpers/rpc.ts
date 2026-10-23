import * as rpcRoute from "@/app/api/rpc/[[...rest]]/route";
import { makeRpcClient, type RpcClient } from "@/lib/rpc/client";

/**
 * The oRPC client driving the real /api/rpc route module in-process (rules 3421-3424): what the browser would send,
 * handed to `POST` instead of the network, with the proxy's same-origin header and a fresh address added. `seen` keeps
 * what the client sent (URL, method, credentials) so a test can check it.
 */
export const RPC_ORIGIN = "https://thakeen.com";
export const rpcSeen: { url: string; method: string; credentials?: string }[] = [];

let ipN = 0;
/** Never repeats within a run, and never meets the IPs other test files use. */
const freshIp = () => { ipN++; return `100.65.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };

export const rpcInProcess: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  rpcSeen.push({ url: req.url, method: req.method, credentials: init?.credentials });
  const headers = new Headers(req.headers);
  headers.set("origin", RPC_ORIGIN);
  headers.set("x-forwarded-for", freshIp());
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  return rpcRoute.POST(new Request(req.url, { method: req.method, headers, body }));
};

/** A typed client over the route module. */
export const rpcTestClient = (): RpcClient => makeRpcClient({ url: "https://nashr.test/api/rpc", fetchImpl: rpcInProcess });
