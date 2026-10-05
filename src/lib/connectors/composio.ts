import { createHmac } from "crypto";
import { db } from "../db";
import { allow } from "../rate";
import { appOrigin } from "../origin";
import { connectSecret } from "./store";
import { PROVIDER_TOOLKITS, TOOLKITS, type Toolkit } from "./composio-catalog";

/**
 * The only file that talks to Composio (docs/superpowers/specs/2026-10-05-meta-via-composio-design.md, section 3).
 * Composio holds the platform tokens; Thakeen keeps the connected account's id in the encrypted connection record and
 * sends Composio an opaque user id derived from the workspace scope, never an email or a brand name.
 *
 * - Every call goes through the allowlist in composio-catalog.ts, with argument names checked against it.
 * - A write is never retried here: an error after a write was sent is "result unknown" for publish-once.ts.
 * - Errors carry a short code shaped like the direct connectors' ("meta create_post 502: …", "x 401: …"), so
 *   `mayHavePosted` and `refusedToken` treat them the same way. No token, account id or response body is logged.
 * - No model, chat tool or MCP tool reaches this file (tests/composio-isolation.test.ts).
 */

type ExecResult = { data?: unknown; error?: string | null; successful: boolean };
export type ComposioClient = {
  connectedAccounts: {
    link(userId: string, authConfigId: string, o: { callbackUrl: string }): Promise<{ id: string; redirectUrl?: string | null }>;
    waitForConnection(id: string, timeoutMs?: number): Promise<{ id: string; status?: string }>;
    list(q: { userIds: string[]; toolkitSlugs?: string[]; statuses?: "ACTIVE"[] }): Promise<{ items: { id: string }[] }>;
    revoke(id: string): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
  tools: {
    execute(slug: string, body: { userId: string; connectedAccountId: string; arguments: Record<string, unknown>; version?: string }, o?: { signal?: AbortSignal }): Promise<ExecResult>;
  };
};

/** Pinned toolkit versions, set from the measured run (plan Task 8). Empty means Composio's default for the key. */
export const TOOLKIT_VERSION: Partial<Record<Toolkit, string>> = {};

const CALL_TIMEOUT_MS = 20_000;
export const PER_ACCOUNT_HOURLY = 600;
const MONTH_KEY_TTL = 40 * 86400;

let client: ComposioClient | null = null;
let testClient: ComposioClient | null = null;

export function setComposioClientForTests(c: ComposioClient | null) {
  testClient = c;
}

async function getClient(): Promise<ComposioClient> {
  if (!process.env.COMPOSIO_API_KEY) throw new Error("composio_unavailable");
  if (testClient) return testClient;
  if (client) return client;
  const { Composio } = await import("@composio/core");
  client = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false, toolkitVersions: TOOLKIT_VERSION }) as unknown as ComposioClient;
  return client;
}

const hmac = (tag: string, scope: string) => createHmac("sha256", connectSecret()).update(tag + scope).digest("base64url");

/** What Composio knows a workspace by: stable per scope, opaque, recomputed from `sc(u)` on every call. */
export const composioUserId = (scope: string) => hmac("composio:user:v1:", scope).slice(0, 32);
/** The per-account hourly rate bucket (`rate:` + this). */
export const bucketFor = (scope: string) => `composio:${hmac("composio:bucket:v1:", scope).slice(0, 16)}`;

const listed = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The provider connects through Composio: the key is set and COMPOSIO_PROVIDERS names it. */
export function composioEnabled(provider: string): boolean {
  return !!process.env.COMPOSIO_API_KEY && !!PROVIDER_TOOLKITS[provider] && listed(process.env.COMPOSIO_PROVIDERS).includes(provider);
}

/** Enabled, and every toolkit of the provider has its auth config id. */
export function composioReady(provider: string): boolean {
  return composioEnabled(provider) && (PROVIDER_TOOLKITS[provider] ?? []).every((t) => !!process.env[TOOLKITS[t].authEnv]);
}

/** "meta create_post 502: text" for Meta (publish-once's `meta [\w-]+ NNN`), "x 502: create_post text" for the rest. */
function shaped(toolkit: Toolkit, slug: string, status: number, text: string): Error {
  const provider = TOOLKITS[toolkit].provider;
  const short = slug.toLowerCase().replace(/^[a-z]+_/, "");
  const detail = text.replace(/\s+/g, " ").slice(0, 120);
  return new Error(provider === "meta" ? `meta ${short} ${status}: ${detail}` : `${provider} ${status}: ${short} ${detail}`);
}

/** The adapter's own reading of a failure; a number inside the platform's text never becomes the status. */
export function statusOf(text: string): number {
  if (/expired|revoked|invalid_grant|unauthori[sz]ed|reconnect|inactive account/i.test(text)) return 401;
  if (/rate.?limit|too many requests/i.test(text)) return 429;
  return 502;
}

async function count(scope: string) {
  if (!(await allow(bucketFor(scope), PER_ACCOUNT_HOURLY, 3600))) throw new Error("composio_rate_limited");
  const now = new Date();
  const month = `composio:calls:${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  await db.incrby(month, 1);
  await db.expireNx(month, MONTH_KEY_TTL).catch(() => {});
}

async function run(kind: "read" | "write", scope: string, toolkit: Toolkit, slug: string, args: Record<string, unknown>, accountId: string): Promise<unknown> {
  const tools = TOOLKITS[toolkit]?.[kind];
  if (!tools || !Object.prototype.hasOwnProperty.call(tools, slug)) throw new Error("composio_tool_not_allowed");
  const allowed = tools[slug];
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new Error("composio_argument_not_allowed");
  if (!accountId) throw new Error("not_connected");
  const c = await getClient();
  await count(scope);
  let r: ExecResult;
  try {
    r = await c.tools.execute(slug, { userId: composioUserId(scope), connectedAccountId: accountId, arguments: args }, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (e) {
    // A timeout keeps its name so publish-once reads it as "may have posted"; anything else is a failure of this tool.
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
    const status = statusOf(e instanceof Error ? e.message : "");
    console.error("composio call failed", slug, status);
    throw shaped(toolkit, slug, status, "call_failed");
  }
  if (r.successful) return r.data;
  const status = statusOf(r.error ?? "");
  console.error("composio tool refused", slug, status);
  throw shaped(toolkit, slug, status, r.error ?? "failed");
}

export const composioRead = (scope: string, toolkit: Toolkit, slug: string, args: Record<string, unknown>, accountId: string) => run("read", scope, toolkit, slug, args, accountId);
export const composioWrite = (scope: string, toolkit: Toolkit, slug: string, args: Record<string, unknown>, accountId: string) => run("write", scope, toolkit, slug, args, accountId);

const okRedirect = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
};

const quietDelete = (c: ComposioClient, id: string) => c.connectedAccounts.delete(id).then(() => undefined, () => undefined);

/** Start a connection: the browser goes to `redirectUrl` (only ever a composio.dev host), then back to our callback with the state. */
export async function composioConnect(scope: string, toolkit: Toolkit, state: string): Promise<{ accountId: string; redirectUrl: string }> {
  const auth = process.env[TOOLKITS[toolkit].authEnv];
  if (!auth) throw new Error("provider_not_configured");
  const c = await getClient();
  await count(scope);
  const req = await c.connectedAccounts.link(composioUserId(scope), auth, { callbackUrl: `${appOrigin()}/api/connect/${TOOLKITS[toolkit].provider}/callback?state=${encodeURIComponent(state)}` });
  if (!req.redirectUrl || !okRedirect(req.redirectUrl)) {
    await quietDelete(c, req.id);
    throw new Error("composio_bad_redirect");
  }
  return { accountId: req.id, redirectUrl: req.redirectUrl };
}

/** The account is ACTIVE and belongs to this workspace's Composio user; otherwise it is deleted and `connect_failed` thrown. */
export async function composioVerify(scope: string, toolkit: Toolkit, accountId: string): Promise<void> {
  const c = await getClient();
  try {
    const a = await c.connectedAccounts.waitForConnection(accountId, 10_000);
    if (a.status && a.status !== "ACTIVE") throw new Error("not_active");
    const mine = await c.connectedAccounts.list({ userIds: [composioUserId(scope)], toolkitSlugs: [toolkit], statuses: ["ACTIVE"] });
    if (!mine.items.some((x) => x.id === accountId)) throw new Error("not_owner");
  } catch {
    await quietDelete(c, accountId);
    throw new Error("connect_failed");
  }
}

/** Revoke at the platform, then delete at Composio. Rejects on either failure so the caller keeps its record. */
export async function composioRevoke(scope: string, accountId: string): Promise<void> {
  const c = await getClient();
  await count(scope);
  await c.connectedAccounts.revoke(accountId);
  await c.connectedAccounts.delete(accountId);
}
