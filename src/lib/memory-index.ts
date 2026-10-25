import type { Scope } from "./keys";
import type { Fact } from "./memory";

/**
 * The search index behind recall (Thakeen v2 phase 1, C5, rule 4560): Upstash Vector, one namespace per workspace scope,
 * with the index's own embedding model (the index is created with a multilingual model, so Arabic word forms match; see
 * docs/system/variables.md). Plain REST over `fetch`: the URL and token are ours, from the environment, never a request's.
 *
 * The index is a copy. The facts themselves are in Redis (`mem:{scope}`, src/lib/memory.ts), and recall keeps only ids it
 * finds there, so a stale or misdirected index entry can never put another workspace's text into a prompt. Without the
 * two variables every call here does nothing and recall uses the word match.
 */
const TIMEOUT_MS = 3000;

function conf(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_VECTOR_REST_URL?.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export const vectorConfigured = (): boolean => conf() !== null;

/** The namespace of one scope: the scope itself, escaped for a URL path segment. */
export const namespaceOf = (s: Scope): string => encodeURIComponent(s);

async function call(method: "POST" | "DELETE", path: string, body: unknown): Promise<unknown> {
  const c = conf();
  if (!c) return null;
  const res = await fetch(`${c.url}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`vector ${path.split("/")[0]} ${res.status}`);
  return res.json().catch(() => null);
}

/** Add or replace one saved fact in its scope's namespace. Only the text and its scope labels are sent, never `by`. */
export async function indexFact(s: Scope, f: Fact): Promise<void> {
  await call("POST", `upsert-data/${namespaceOf(s)}`, [
    {
      id: f.id,
      data: f.text,
      metadata: { scope: f.scope, ...(f.agent ? { agent: f.agent } : {}), ...(f.conv ? { conv: f.conv } : {}) },
    },
  ]);
}

export async function forgetVectors(s: Scope, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await call("DELETE", `delete/${namespaceOf(s)}`, { ids });
}

/** The whole namespace of a scope, for `wipeAccount`. */
export async function dropNamespace(s: Scope): Promise<void> {
  await call("DELETE", `delete-namespace/${namespaceOf(s)}`, undefined);
}

/** The ids nearest to `query` in this scope's namespace, best first; [] when the index is not configured. */
export async function nearestIds(s: Scope, query: string, topK: number): Promise<string[]> {
  const out = (await call("POST", `query-data/${namespaceOf(s)}`, { data: query, topK, includeMetadata: false })) as {
    result?: { id?: unknown }[];
  } | null;
  return (out?.result ?? []).map((r) => r.id).filter((id): id is string => typeof id === "string");
}
