import type { APIRequestContext, APIResponse } from "@playwright/test";
import { WS_HEADER, workspaceFree } from "../../src/lib/ws-path";

/**
 * Direct API calls name their workspace like the app does (rules 2113, 3810). With `MULTI_ORG` on, a state-changing call
 * to a workspace API without `x-thakeen-ws` answers 409 `workspace_missing`; in the browser the fetch wrapper
 * (`installBrandFetch`, src/lib/brand-fetch.ts) sends the page's handle. A spec's API request has no page, so this sends
 * the handle of the workspace the session has open now (`GET /api/workspaces`, the entry marked `current`), read again
 * before every such call because a spec may sign in as someone else on the same context. A call that names its own
 * handle (tenant-isolation.spec.ts forges one) is sent as it is, and so is a call with no session or no open workspace:
 * the server then answers it as it would a browser.
 */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PATCHED = Symbol.for("thakeen.e2e.workspaceHeader");

type Options = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>;
type Fetch = (this: APIRequestContext, urlOrRequest: Parameters<APIRequestContext["fetch"]>[0], options?: Options) => Promise<APIResponse>;

async function currentHandle(ctx: APIRequestContext, fetch: Fetch, url: string, options: Options): Promise<string | undefined> {
  const at = url.startsWith("/") ? "/api/workspaces" : new URL("/api/workspaces", url).href;
  const res = await fetch.call(ctx, at, { method: "GET", headers: options.headers, failOnStatusCode: false });
  if (!res.ok()) return undefined;
  const body = (await res.json()) as { workspaces?: Array<{ handle: string; current?: boolean }> };
  return body.workspaces?.find((w) => w.current)?.handle;
}

/** Patches every request context of this worker once: they all share one prototype, `page.request` included. */
export function installWorkspaceHeader(ctx: APIRequestContext): void {
  const proto = Object.getPrototypeOf(ctx) as { fetch: Fetch; [PATCHED]?: true };
  if (proto[PATCHED]) return;
  const fetch = proto.fetch;
  proto.fetch = async function (this: APIRequestContext, urlOrRequest, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    const headers = options.headers ?? {};
    if (typeof urlOrRequest !== "string" || !STATE_CHANGING.has(method) || Object.keys(headers).some((k) => k.toLowerCase() === WS_HEADER)) {
      return fetch.call(this, urlOrRequest, options);
    }
    const path = new URL(urlOrRequest, "http://e2e.invalid").pathname;
    if (!path.startsWith("/api/") || workspaceFree(path)) return fetch.call(this, urlOrRequest, options);
    const handle = await currentHandle(this, fetch, urlOrRequest, options);
    return fetch.call(this, urlOrRequest, handle ? { ...options, headers: { ...headers, [WS_HEADER]: handle } } : options);
  };
  proto[PATCHED] = true;
}
