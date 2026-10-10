import type { AppDict } from "./app-i18n";
import type { Draft, Instruction, Layer } from "./instructions-store";

/**
 * What the customer instructions page and its editor share with their tests (agent skills portal, spec 8.1, rule 957).
 * Pure: the browser imports it, so it reads no key and imports no server module (types only).
 */

/** A string from the dictionary with its {placeholders} filled; a placeholder with no value stays as written. */
export const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(v, k) ? String(v[k]) : m));

type ErrorKey = keyof AppDict["instructions"]["errors"];

/**
 * Every `error` code the instruction routes (and the reference-file routes) can answer, and the message that says it.
 * Several codes of a request that only a broken page can send share `invalid`. A code that is not here gets the generic
 * message, so a new server code never shows as an empty line (the dictionary test lists every code).
 */
const ERROR_KEY = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  slow_down: "slow_down",
  busy: "busy",
  stale: "stale",
  no_draft: "no_draft",
  not_found: "not_found",
  too_long: "too_long",
  too_many: "too_many",
  bad_target: "bad_target",
  injection: "injection",
  authority: "authority",
  secret: "secret",
  instructions_limit: "instructions_limit",
  per_agent_plan: "per_agent_plan",
  refs_plan: "refs_plan",
  bad_items: "invalid",
  bad_base: "invalid",
  bad_body: "invalid",
  bad_request: "invalid",
  bad_type: "invalid",
  bad_nonce: "invalid",
  confirm_required: "invalid",
  brief_too_long: "brief_too_long",
  no_brand: "no_brand",
  trial_over: "trial_over",
  model_paused: "model_unavailable",
  model_unavailable: "model_unavailable",
  duplicate: "duplicate",
  no_credits: "no_credits",
  agent_cap: "agent_cap",
  generation_failed: "generation_failed",
  refund_failed: "refund_failed",
  not_connected: "not_connected",
  empty: "empty",
  files_full: "files_full",
  upstream: "upstream",
} as const satisfies Record<string, ErrorKey>;
export const INSTRUCTION_ERROR_CODES: readonly string[] = Object.keys(ERROR_KEY);

/** The message for a refused request, in the page's language. `vars` fills {max}. */
export function errorText(t: AppDict, code: unknown, vars: Record<string, string | number> = {}): string {
  const E = t.instructions.errors;
  const key: ErrorKey = typeof code === "string" && Object.hasOwn(ERROR_KEY, code) ? ERROR_KEY[code as keyof typeof ERROR_KEY] : "failed";
  return fill(E[key], vars);
}

/** The reasons a refused text carries an `index` for: they belong on that row, the rest on the page. */
export const ROW_CODES: ReadonlySet<string> = new Set(["injection", "authority", "secret", "too_long", "too_many", "bad_target"]);

/**
 * The `base` a save names: the layer's edit counter, or for a layer stored before the counter the draft's version (the
 * live set's when there is no draft). The same rule as `editBase` in instructions-store.ts, which the browser cannot import.
 */
export const editBaseOf = (l: Pick<Layer, "seq" | "draft" | "active">): number => l.seq ?? l.draft?.v ?? l.active.v;

/** One nonce per confirmed click of the Test button (the route claims it before it charges). 36 characters, accepted by the route's pattern. */
export const newNonce = (): string => crypto.randomUUID();

/** A stored item as the form edits it: no edit time, no source. */
export const toDraft = (i: Instruction): Draft => ({
  id: i.id,
  text: i.text,
  agents: i.agents,
  on: i.on,
  ...(i.lock ? { lock: true } : {}),
  ...(i.refs?.length ? { refs: i.refs } : {}),
});

const sig = (d: Draft) => JSON.stringify([d.id ?? "", d.text, d.on, d.agents === "all" ? "all" : [...d.agents].sort(), d.lock === true, d.refs ?? []]);

/** Whether two lists of rows are the same edit: text, switch, targets, lock and files (a new row has no id and is never the same as a stored one). */
export const sameDrafts = (a: Draft[], b: Draft[]): boolean => a.length === b.length && a.every((d, i) => sig(d) === sig(b[i]));
