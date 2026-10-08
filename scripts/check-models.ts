// Checks that every model in the catalog (src/lib/models/catalog.ts) is in the list the Straitly gateway offers our key
// (GET <base>/v1/models). Spec 2026-10-08-straitly-model-routing, section 3. Run by hand and in the release checklist,
// never at build time and not as part of `npm run check`: it needs the network and the gateway key.
//
// Usage:  STRAITLY_API_KEY=... npx jiti scripts/check-models.ts
// (jiti runs the TypeScript catalog without a build step. STRAITLY_BASE_URL is optional, default https://api.straitly.ai;
// the path /v1/models is added here, so the base has no /v1, the same base src/lib/model.ts uses.)
//
// Exit codes: 0 every catalog id is listed; 1 at least one is not (the ids are printed); 2 the check could not be made
// (no key, a base URL that is not https, a refused or failed request, a list that is not the shape this reads or is paginated).
//
// The key comes from the environment only. It is sent as a bearer header to the gateway and nowhere else, is never put in
// a URL, and is never printed: every message below carries a status code or a fixed sentence, not an error text or a body.
// (src/lib/model.ts is the only reader of STRAITLY_API_KEY inside src, tests/model-timeouts.test.ts; this script is outside
// src and is not part of the app.)
//
// "Listed" is not "works": the dialect and capabilities of each entry come from the spike (plan Task 1), which calls each model.
import { pathToFileURL } from "node:url";
import { MODELS } from "../src/lib/models/catalog";

const DEFAULT_BASE_URL = "https://api.straitly.ai";
const TIMEOUT_MS = 15_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type CheckResult = { code: 0 | 1 | 2; lines: string[] };

/** `<base>/v1/models`, whatever trailing slashes the base has. */
export function modelsUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/models`;
}

/** https only (the key travels in a header), except a loopback address for a local stand-in; the same rule as src/lib/model.ts. */
function safeBase(base: string): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return u.protocol === "https:" || (u.protocol === "http:" && loopback);
}

/** The ids in a `{ data: [{ id }] }` body, or null when the body is any other shape. */
export function parseModelList(body: unknown): string[] | null {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const m of data) {
    const id = (m as { id?: unknown } | null | undefined)?.id;
    if (typeof id !== "string") return null;
    ids.push(id);
  }
  return ids;
}

/** The catalog ids the gateway's list does not contain, in catalog order. */
export function missingIds(catalogIds: readonly string[], listed: readonly string[]): string[] {
  const have = new Set(listed);
  return catalogIds.filter((id) => !have.has(id));
}

export async function checkModels(
  env: Record<string, string | undefined>,
  fetchFn: Fetch,
  ids: readonly string[] = MODELS.map((m) => m.id),
): Promise<CheckResult> {
  const key = env.STRAITLY_API_KEY?.trim();
  if (!key) return { code: 2, lines: ["STRAITLY_API_KEY is not set. Put the gateway key in the environment (it is never printed) and run again."] };
  const base = env.STRAITLY_BASE_URL?.trim() || DEFAULT_BASE_URL;
  if (!safeBase(base)) return { code: 2, lines: ["STRAITLY_BASE_URL must be an https URL (http only for localhost). Nothing was sent."] };

  let res: Response;
  try {
    res = await fetchFn(modelsUrl(base), { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { code: 2, lines: ["The request to the gateway failed before it answered (network error or timeout)."] };
  }
  if (!res.ok) return { code: 2, lines: [`GET /v1/models answered ${res.status}.`] };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { code: 2, lines: ["GET /v1/models did not answer with JSON."] };
  }
  const listed = parseModelList(body);
  if (!listed) return { code: 2, lines: ["GET /v1/models answered in a shape this check does not read (expected { data: [{ id }] })."] };
  // A first page only would report a model as missing when it is on page two. Refuse rather than guess.
  if ((body as { has_more?: unknown }).has_more === true) return { code: 2, lines: ["GET /v1/models is paginated (has_more is true). This check reads one page; extend it before trusting a missing id."] };

  const missing = missingIds(ids, listed);
  if (missing.length) return { code: 1, lines: [`Not in the gateway's list (${missing.length} of ${ids.length}): ${missing.join(", ")}`] };
  return { code: 0, lines: [`All ${ids.length} catalog models are in the gateway's list (${listed.length} listed).`] };
}

async function main(): Promise<void> {
  const { code, lines } = await checkModels(process.env, (url, init) => fetch(url, init));
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
