import type { Surface, Tier } from "./models/tiers";

/**
 * What the model picker does with GET /api/models and how it asks PUT /api/models for a pick (spec
 * 2026-10-08-straitly-model-routing, plan Task 7). Shared with the browser: it imports only types from the tier file, so
 * no rate, no multiplier table and no catalog reaches the client bundle (tests/client-bundle.test.ts). Every number the
 * picker shows is the server's: the multiplier per surface and per model id, and the chat units.
 */

/** The two surfaces a pick applies to: a conversation's chat, a brand's content generation. */
export type PickSurface = Surface;

/** One row of GET /api/models `models`: the browser's copy of `PickerRow` (src/lib/models/catalog.ts). */
export type PickerRowView = { id: string; label: { ar: string; en: string }; tier: Tier; hosting: "west" | "china"; tools: boolean };

/** The GET /api/models answer. */
export type ModelsView = {
  models: PickerRowView[];
  multipliers: Record<Surface, Record<string, number>>;
  chatUnits: Record<string, number>;
  chinaConfirmed: boolean;
};

/**
 * One choice in the list. `id` null is Automatic, always first: no tier and no multiplier (the server prices it at the
 * surface's default). `multiplier` is the server's number for this surface, formatted; `units` the chat messages one
 * message on it counts (chat only).
 */
export type PickerOption = { id: string | null; label: string; tier: Tier | null; china: boolean; multiplier: string | null; units: number | null };

export type PickBody = { confirmChina: true } | { target: "conversation"; id: string; model: string | null } | { target: "brand"; model: string | null };

/** Why a pick did not land. The caller rolls its optimistic change back on every one of them. */
export type Refusal = "signed_out" | "busy" | "unavailable" | "not_found" | "owner_only" | "forbidden" | "slow_down" | "failed";

/** "x0.6", "x1", "x2": at most two decimals, trailing zeros trimmed. */
export function formatMultiplier(n: number): string {
  return `x${String(Math.round(n * 100) / 100)}`;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isNumMap = (x: unknown): x is Record<string, number> => isObj(x) && Object.values(x).every((v) => typeof v === "number");
const isRow = (x: unknown): x is PickerRowView =>
  isObj(x) && typeof x.id === "string" && isObj(x.label) && typeof x.label.ar === "string" && typeof x.label.en === "string" &&
  typeof x.tier === "string" && (x.hosting === "west" || x.hosting === "china") && typeof x.tools === "boolean";

/** The GET /api/models body when it has the expected shape, else null (the picker then says the list did not load). */
export function readModelsView(x: unknown): ModelsView | null {
  if (!isObj(x) || !Array.isArray(x.models) || !x.models.every(isRow)) return null;
  const m = x.multipliers;
  if (!isObj(m) || !isNumMap(m.chat) || !isNumMap(m.generate) || !isNumMap(x.chatUnits) || typeof x.chinaConfirmed !== "boolean") return null;
  return x as ModelsView;
}

const own = (o: Record<string, number>, k: string): number | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/**
 * The list for one surface: Automatic first, then each row the server sent with a multiplier for this surface. Chat
 * leaves out a row that cannot run chat's tools (the server refuses it there). A row without a finite positive
 * multiplier is left out rather than shown with a guessed one.
 */
export function pickerOptions(view: ModelsView, surface: Surface, lang: "ar" | "en", autoLabel: string): PickerOption[] {
  const auto: PickerOption = { id: null, label: autoLabel, tier: null, china: false, multiplier: null, units: null };
  const rows = view.models.flatMap((r): PickerOption[] => {
    if (surface === "chat" && !r.tools) return [];
    const x = own(view.multipliers[surface], r.id);
    if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return [];
    const u = surface === "chat" ? own(view.chatUnits, r.id) : undefined;
    return [{ id: r.id, label: r.label[lang], tier: r.tier, china: r.hosting === "china", multiplier: formatMultiplier(x), units: typeof u === "number" && Number.isFinite(u) ? u : null }];
  });
  return [auto, ...rows];
}

/** The selected entry: the stored id while the list offers it, else Automatic (null), as the server does at call time. */
export function chosenId(stored: unknown, options: readonly PickerOption[]): string | null {
  return typeof stored === "string" && options.some((o) => o.id === stored) ? stored : null;
}

/** A China-hosted entry asks the owner once, until the account's confirmation is stored. */
export const needsChinaConfirm = (o: PickerOption, confirmed: boolean): boolean => o.china && !confirmed;

/**
 * The PUT /api/models bodies for one pick, in order: the owner's confirmation alone first when it is needed (the server
 * refuses it sent with a pick), then the pick. A brand pick names no id: the server uses the active brand.
 */
export function pickBodies(target: "conversation" | "brand", id: string | undefined, model: string | null, confirmFirst: boolean): PickBody[] {
  const pick: PickBody = target === "conversation" ? { target, id: id ?? "", model } : { target, model };
  return confirmFirst ? [{ confirmChina: true }, pick] : [pick];
}

/** One answer per refusal. `confirming`: the request was the China confirmation, which only the owner may give. */
export function pickRefusal(status: number, error: unknown, confirming: boolean): Refusal {
  if (status === 401) return "signed_out";
  if (error === "unknown_model" || error === "not_pickable" || error === "china_unconfirmed") return "unavailable";
  if (status === 503 || error === "busy") return "busy";
  if (status === 404 || error === "not_found") return "not_found";
  if (status === 403) return confirming ? "owner_only" : "forbidden";
  if (status === 429) return "slow_down";
  return "failed";
}

/** Send the bodies in order and stop at the first refusal (a refused confirmation never sends the pick). null: all landed. */
export async function sendPick(bodies: readonly PickBody[], send: (b: PickBody) => Promise<{ status: number; error?: unknown }>): Promise<Refusal | null> {
  for (const b of bodies) {
    let r: { status: number; error?: unknown };
    try {
      r = await send(b);
    } catch {
      return "failed";
    }
    if (r.status < 200 || r.status >= 300) return pickRefusal(r.status, r.error, "confirmChina" in b);
  }
  return null;
}

/** "{x}" and "{n}" filled in. */
export const fill = (s: string, vars: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/**
 * "Each message counts as N messages", only above 1. Arabic counts in three forms: the dual for two, a plural for three
 * to ten, a singular noun from eleven on; English has one form.
 */
export function unitsText(n: number | null, lang: "ar" | "en", forms: { two: string; few: string; many: string }): string | null {
  if (n === null || !Number.isFinite(n) || n <= 1) return null;
  const s = lang === "ar" ? (n === 2 ? forms.two : n <= 10 ? forms.few : forms.many) : forms.few;
  return fill(s, { n });
}
