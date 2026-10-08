import { isTier, type Tier } from "./tiers";

/**
 * The model catalog (spec 2026-10-08-straitly-model-routing, sections 3 and 6): every model the product may call, which
 * price tier it belongs to, what it can do, what each token of it costs us, and whether automatic routing or a customer's
 * pick may use it. SERVER AND TEST ONLY (`SERVER_ONLY` in tests/client-bundle.test.ts): it holds our rates, which are our
 * margins. The browser gets `pickerView()` (no rates) and the multipliers in `tiers.ts`.
 *
 * Imports only the tier names from `tiers.ts`. It must not import `usage.ts`: `usage.ts` reads this catalog for its
 * rates (`costUsd`, `hasRate`), and a cycle would leave one of them half-built.
 */
export type ModelEntry = {
  /** The exact id the provider or the gateway accepts. */
  id: string;
  label: { ar: string; en: string };
  vendor: string;
  /** Where the inference runs. A `"china"` entry is labelled in the picker and is never chosen by automatic routing. */
  hosting: "west" | "china";
  tier: Tier;
  /** Which wire format the gateway wants for this model: Anthropic `/messages` or OpenAI `/chat/completions`. */
  dialect: "messages" | "chat";
  caps: { tools: boolean; strict: boolean; thinking: boolean; cache: boolean; vision: boolean };
  /** USD per million tokens that WE pay for this model by the route it normally takes (see the note on `MODELS`). */
  rate: { in: number; out: number; cacheRead: number; cacheWrite: number };
  /** Automatic routing may use it. Must be false when `hosting` is `"china"` (`validateCatalog`). */
  auto: boolean;
  /** A customer may choose it for chat or content generation. */
  pick: boolean;
  /**
   * Task types it may run, when it must not run all of them: a model that cannot meet the margin floor on some at the
   * credits its tier charges (tests/pricing-floor.test.ts, rule 241 by tier). Unset: every type (`modelAllowsTask`).
   */
  tasks?: readonly string[];
};

function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

/**
 * The task types a standard-tier Claude model may run: every type but `article` and `followup_seq`. Generation is priced
 * at Opus 5 (`PRICED_AT.generate`), so a standard model charges x0.5 (src/lib/models/credits.ts); the reviewer and the
 * judge cost the same whatever model generated, and on these two types the cost per charged credit stays over the margin
 * floor even on a warm cache (article $0.0791, followup_seq $0.0739 against $0.0710; tests/pricing-floor.test.ts, rule 241
 * by tier). Written out rather than derived from the task list on purpose: a new task type runs on these models only once
 * it is added here, after the floor test has priced it. `generateBatch` refuses a type outside the list before charging.
 */
const STANDARD_CLAUDE_TASKS: readonly string[] = [
  "weekly_plan", "social", "whatsapp", "ads", "gbp", "cart_recovery", "sales_script", "lead_qualifier",
  "pricing_review", "unit_economics", "cash_forecast", "gtm_plan", "growth_experiments", "retention_play", "weekly_report",
  "board_deck", "dashboard_spec", "strategy_review", "okrs", "decision_memo", "prd", "roadmap", "feedback_synthesis",
  "onboarding_flow",
];

/**
 * Rates. `rate` is what we actually pay per million tokens by the route the model normally takes. The three Claude rates
 * were copied on 2026-10-08 from the `RATES` table in `usage.ts`, whose list prices were checked on 2026-09-27 (Sonnet 5.5
 * added 2026-10-02); they were not checked again against Anthropic's or Straitly's price list when copied:
 *
 * - A Claude model can also be called directly at Anthropic (the gateway's fallback, `src/lib/model.ts`), and there it
 *   costs the full list price. Its `rate` is therefore the CURRENT ANTHROPIC LIST PRICE, the same numbers the old `RATES`
 *   table in `usage.ts` holds. The gateway sells the same models for less; pricing the fallback case keeps the margin
 *   floor honest on the worst route and changes no figure we meter today.
 * - A model that is reachable only through the Straitly gateway carries the gateway's price: provider list price x 0.6
 *   (the gateway is 40% below list on each of the four buckets).
 *
 * Update both when a provider changes a price, and move the date. `tests/pricing-floor.test.ts` prices every task on these.
 *
 * Only the three Claude models used today are listed. The other vendors' entries (with their `dialect` and `caps`) come
 * from the Straitly spike (plan Task 1: `GET /v1/models`, then one call per model) and are added after it has run; so is
 * the target of 5 to 8 entries with `pick: true`. A model is added here with `auto: false` until the golden set has run on
 * it, and a China-hosted one always with `auto: false`.
 */
export const MODELS: readonly ModelEntry[] = deepFreeze<ModelEntry[]>([
  {
    id: "claude-opus-5",
    label: { ar: "كلود أوبس 5", en: "Claude Opus 5" },
    vendor: "anthropic",
    hosting: "west",
    tier: "premium",
    dialect: "messages",
    caps: { tools: true, strict: true, thinking: true, cache: true, vision: true },
    rate: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    auto: true,
    pick: true,
  },
  {
    id: "claude-sonnet-5",
    label: { ar: "كلود سونيت 5", en: "Claude Sonnet 5" },
    vendor: "anthropic",
    hosting: "west",
    tier: "standard",
    dialect: "messages",
    caps: { tools: true, strict: true, thinking: true, cache: true, vision: true },
    rate: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    auto: true,
    pick: true,
    tasks: STANDARD_CLAUDE_TASKS,
  },
  {
    id: "claude-sonnet-5-5",
    label: { ar: "كلود سونيت 5.5", en: "Claude Sonnet 5.5" },
    vendor: "anthropic",
    hosting: "west",
    tier: "standard",
    dialect: "messages",
    caps: { tools: true, strict: true, thinking: true, cache: true, vision: true },
    rate: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    auto: true,
    pick: true,
    tasks: STANDARD_CLAUDE_TASKS,
  },
]);

/** Map-backed on purpose: a plain object lookup would answer for "constructor" and "__proto__". */
const BY_ID: ReadonlyMap<string, ModelEntry> = new Map(MODELS.map((m) => [m.id, m]));
const AUTO: readonly ModelEntry[] = Object.freeze(MODELS.filter((m) => m.auto));
const PICK: readonly ModelEntry[] = Object.freeze(MODELS.filter((m) => m.pick));

/** The entry for `id`, or undefined for anything that is not exactly a catalog id (non-strings, unknown ids, prototype names). */
export function modelById(id: unknown): ModelEntry | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** True when `m` may run task type `type`: its `tasks` allow-list names it, or it has none (it may run every type). */
export function modelAllowsTask(m: Pick<ModelEntry, "tasks">, type: string): boolean {
  return !m.tasks || m.tasks.includes(type);
}

/** What automatic routing may choose from. */
export function autoModels(): readonly ModelEntry[] {
  return AUTO;
}

/** What a customer may choose for chat or content generation. */
export function pickModels(): readonly ModelEntry[] {
  return PICK;
}

/**
 * One row of the model picker: no rate, no vendor, and of the capabilities only `tools` (`caps.tools`), which the chat
 * picker needs to leave out a model that cannot run chat's tools (PUT /api/models refuses it there as `not_pickable`).
 * A copy, so a caller cannot change the catalog through it. The browser's copy of this shape is `PickerRowView` in
 * src/lib/model-picker.ts (tests/model-picker-copy.test.ts checks that this one fits it).
 */
export type PickerRow = { id: string; label: ModelEntry["label"]; tier: Tier; hosting: ModelEntry["hosting"]; tools: boolean };

/** The picker projection of a list: the entries a customer may pick, as `PickerRow`s. Pure, so a test can feed it any list. */
export function toPickerView(entries: readonly ModelEntry[]): PickerRow[] {
  return entries.filter((m) => m.pick).map((m) => ({ id: m.id, label: { ar: m.label.ar, en: m.label.en }, tier: m.tier, hosting: m.hosting, tools: m.caps.tools }));
}

/** What the browser may know about the models a customer can pick. Never rates (the client bundle must not carry our margins). */
export function pickerView(): PickerRow[] {
  return toPickerView(MODELS);
}

const text = (x: unknown): boolean => typeof x === "string" && x.trim().length > 0;

/**
 * Every way a list of entries can be wrong, as readable messages; an empty array means the list is sound. Pure, so
 * tests/model-catalog.test.ts checks the real `MODELS` with it and feeds it lists with one defect each.
 */
export function validateCatalog(entries: readonly ModelEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of entries) {
    const who = JSON.stringify(m.id);
    if (!text(m.id)) problems.push(`entry without an id: ${who}`);
    else if (seen.has(m.id)) problems.push(`duplicate id ${who}`);
    else seen.add(m.id);
    if (!text(m.vendor)) problems.push(`${who}: vendor must be non-empty text`);
    if (!text(m.label?.ar) || !text(m.label?.en)) problems.push(`${who}: label.ar and label.en must be non-empty text`);
    if (!isTier(m.tier)) problems.push(`${who}: tier ${JSON.stringify(m.tier)} is not economy, standard or premium`);
    if (m.hosting !== "west" && m.hosting !== "china") problems.push(`${who}: hosting ${JSON.stringify(m.hosting)} is not west or china`);
    if (m.dialect !== "messages" && m.dialect !== "chat") problems.push(`${who}: dialect ${JSON.stringify(m.dialect)} is not messages or chat`);
    for (const k of ["tools", "strict", "thinking", "cache", "vision"] as const) {
      if (typeof m.caps?.[k] !== "boolean") problems.push(`${who}: caps.${k} must be true or false`);
    }
    for (const k of ["auto", "pick"] as const) {
      if (typeof m[k] !== "boolean") problems.push(`${who}: ${k} must be true or false`);
    }
    if (m.hosting === "china" && m.auto) problems.push(`${who} is hosted in china but auto is true: automatic routing never uses a China-hosted model`);
    let ratesOk = true;
    for (const k of ["in", "out", "cacheRead", "cacheWrite"] as const) {
      const v = m.rate?.[k];
      if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) {
        ratesOk = false;
        problems.push(`${who}: rate.${k} must be a finite number above 0`);
      }
    }
    if (ratesOk && !(m.rate.cacheRead < m.rate.in && m.rate.in < m.rate.cacheWrite)) problems.push(`${who}: rate must satisfy cacheRead < in < cacheWrite`);
  }
  return problems;
}
