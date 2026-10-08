import { createHmac } from "crypto";
import { db } from "../db";
import { allow } from "../rate";
import { appOrigin } from "../origin";
import { connectSecret } from "./store";
import { PROVIDER_TOOLKITS, TOOLKITS, type Toolkit } from "./composio-catalog";
import { isOurBlobUrl } from "../media-catalog";

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
    link(userId: string, authConfigId: string, o: { callbackUrl: string; allowMultiple?: boolean }): Promise<{ id: string; redirectUrl?: string | null }>;
    waitForConnection(id: string, timeoutMs?: number): Promise<{ id: string; status?: string }>;
    list(q: { userIds: string[]; toolkitSlugs?: string[]; statuses?: "ACTIVE"[] }): Promise<{ items: { id: string }[] }>;
    revoke(id: string): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
  tools: {
    execute(slug: string, body: { userId: string; connectedAccountId: string; arguments: Record<string, unknown>; version?: string }, o?: { signal?: AbortSignal }): Promise<ExecResult>;
  };
  files: {
    upload(p: { file: string; toolSlug: string; toolkitSlug: string }): Promise<{ name?: string; mimetype?: string; s3key?: string }>;
  };
};
export type StagedFile = { name: string; mimetype: string; s3key: string };

/**
 * Pinned toolkit versions (rule 749). facebook, youtube, linkedin, tiktok and snapchat are pinned to the `version` that
 * `composio tools info <slug>` reported on 2026-10-08, when their allowlisted args were checked; the other pins date
 * from 2026-10-05 and were not re-read with `tools info`. The `latest_version` field of `dev toolkits version` is stale
 * and is not used. The SDK refuses to execute a tool whose toolkit resolves to "latest"
 * (ComposioToolVersionRequiredError, before any request), and fetches the tool at the pinned version before any
 * platform call (ComposioToolNotFoundError when it is missing there), so a pin also keeps the argument names in
 * composio-catalog.ts matching the schema they were checked against. "00000000_00" is the only version Composio lists
 * for an unversioned toolkit. Every toolkit must have one: the type has no optional keys.
 */
export const TOOLKIT_VERSION: Readonly<Record<Toolkit, string>> = {
  facebook: "20261008_00",
  instagram: "20251229_00",
  twitter: "20251230_00",
  linkedin: "20260924_00",
  tiktok: "20260917_00",
  whatsapp: "00000000_00",
  youtube: "20261008_00",
  metaads: "20251208_00",
  snapchat: "20260918_00",
  googleads: "00000000_00",
  tiktok_ads: "00000000_00",
  google_analytics: "20251017_00",
  google_search_console: "00000000_00",
};

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

/** A platform's refusal for want of a scope, as TikTok words it, in a text the client threw. */
const SCOPE_REFUSED = /scope_not_authorized|scope_permission_missed/i;

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
  // A value the catalog pins (a private upload, an inbox draft) is checked here, whatever the caller built.
  const fixed = kind === "write" ? TOOLKITS[toolkit].fixed?.[slug] : undefined;
  if (fixed) for (const [k, v] of Object.entries(fixed)) if (args[k] !== v) throw new Error("composio_argument_not_allowed");
  if (!accountId) throw new Error("not_connected");
  const c = await getClient();
  await count(scope);
  let r: ExecResult;
  try {
    r = await c.tools.execute(slug, { userId: composioUserId(scope), connectedAccountId: accountId, arguments: args }, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (e) {
    // A timeout keeps its name so publish-once reads it as "may have posted"; anything else is a failure of this tool.
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
    const text = e instanceof Error ? e.message : "";
    const status = statusOf(text);
    console.error("composio call failed", slug, status);
    // Only the adapter's own word, never the thrown text, which can carry ids; a scope refusal keeps its name, so a
    // reader can tell it from a refused token (TikTok's tt_no_scope, rule 742).
    throw shaped(toolkit, slug, status, SCOPE_REFUSED.test(text) ? "scope_not_authorized" : "call_failed");
  }
  if (r.successful) return r.data;
  const status = statusOf(r.error ?? "");
  console.error("composio tool refused", slug, status);
  throw shaped(toolkit, slug, status, r.error ?? "failed");
}

export const composioRead = (scope: string, toolkit: Toolkit, slug: string, args: Record<string, unknown>, accountId: string) => run("read", scope, toolkit, slug, args, accountId);
export const composioWrite = (scope: string, toolkit: Toolkit, slug: string, args: Record<string, unknown>, accountId: string) => run("write", scope, toolkit, slug, args, accountId);

const STAGE_TIMEOUT_MS = 30_000;

/**
 * Stage a file with Composio for a write tool that takes one (YouTube's upload). Only our own Vercel Blob copy is ever
 * handed over (isOurBlobUrl), so Composio fetches nothing a request or a model chose. Nothing is posted yet: a failure
 * here is a refusal (`composio_stage_failed`), never "may have posted".
 */
export async function composioStageFile(scope: string, toolkit: Toolkit, slug: string, url: string): Promise<StagedFile> {
  if (!Object.prototype.hasOwnProperty.call(TOOLKITS[toolkit]?.write ?? {}, slug)) throw new Error("composio_tool_not_allowed");
  if (!isOurBlobUrl(url)) throw new Error("composio_file_not_allowed");
  const c = await getClient();
  await count(scope);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const f = await Promise.race([
      c.files.upload({ file: url, toolSlug: slug, toolkitSlug: toolkit }),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timeout")), STAGE_TIMEOUT_MS); }),
    ]);
    if (!f?.s3key || !f.name || !f.mimetype) throw new Error("no_key");
    return { name: f.name, mimetype: f.mimetype, s3key: f.s3key };
  } catch {
    console.error("composio stage failed", slug);
    throw new Error("composio_stage_failed");
  } finally {
    clearTimeout(timer);
  }
}

const okRedirect = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
};

/**
 * A loggable shape of an SDK error: class names down the cause chain, HTTP status and Composio error code. Never the
 * message or body, which can carry ids or platform text.
 */
export function errorShape(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 3 && cur && typeof cur === "object"; i++) {
    const o = cur as { constructor?: { name?: string }; status?: unknown; code?: unknown; cause?: unknown };
    const name = o.constructor?.name ?? "";
    if (/^[A-Za-z]{1,60}$/.test(name)) parts.push(name);
    if (typeof o.status === "number") parts.push(String(o.status));
    if (typeof o.code === "string" && /^[A-Za-z0-9_.:-]{1,60}$/.test(o.code)) parts.push(o.code);
    cur = o.cause;
  }
  return parts.join(" ") || "error";
}

const quietDelete = (c: ComposioClient, id: string) => c.connectedAccounts.delete(id).then(() => undefined, () => undefined);

/** Start a connection: the browser goes to `redirectUrl` (only ever a composio.dev host), then back to our callback with the state. */
export async function composioConnect(scope: string, toolkit: Toolkit, state: string): Promise<{ accountId: string; redirectUrl: string }> {
  const auth = process.env[TOOLKITS[toolkit].authEnv];
  if (!auth) throw new Error("provider_not_configured");
  const c = await getClient();
  await count(scope);
  const req = await c.connectedAccounts.link(composioUserId(scope), auth, {
    callbackUrl: `${appOrigin()}/api/connect/${TOOLKITS[toolkit].provider}/callback?state=${encodeURIComponent(state)}`,
    // A reconnect holds two accounts until the callback revokes the old one (connectViaComposio); without this the SDK
    // refuses the link while the old account is still ACTIVE (TS-SDK::MULTIPLE_CONNECTED_ACCOUNTS).
    allowMultiple: true,
  });
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

/** Delete an account the callback verified but could not store, so it does not linger ACTIVE at Composio. Never throws. */
export async function composioDiscard(accountId: string): Promise<void> {
  const c = await getClient().catch(() => null);
  if (c) await quietDelete(c, accountId);
}

/** Revoke at the platform, then delete at Composio. Rejects on either failure so the caller keeps its record. */
export async function composioRevoke(scope: string, accountId: string): Promise<void> {
  const c = await getClient();
  await count(scope);
  await c.connectedAccounts.revoke(accountId);
  await c.connectedAccounts.delete(accountId);
}
