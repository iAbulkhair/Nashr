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
  /**
   * The generation multiplier per task type and model id (rule 902): relative to that type's own writer, so it differs by
   * type. Only the types a model may run. Absent from an older server's answer: the picker then shows `multipliers.generate`.
   */
  generateByTask?: Record<string, Record<string, number>>;
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
  const g = x.generateByTask;
  if (g !== undefined && (!isObj(g) || !Object.values(g).every(isNumMap))) return null;
  return x as ModelsView;
}

const own = (o: Record<string, number>, k: string): number | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const usable = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/**
 * A generation pick's multiplier as the brand picker shows it. A brand's pick covers every task type and each type is
 * priced relative to its own writer (rule 902), so it is the range over the types the model may run: "x1" when they all
 * agree, "x0.5–1" when they do not. Without `generateByTask` (an older server), the single `multipliers.generate`.
 */
function generateMultiplier(view: ModelsView, id: string): string | null {
  if (view.generateByTask === undefined) {
    const x = own(view.multipliers.generate, id);
    return usable(x) ? formatMultiplier(x) : null;
  }
  const xs = Object.values(view.generateByTask).map((row) => own(row, id)).filter(usable);
  if (xs.length === 0) return null;
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return lo === hi ? formatMultiplier(lo) : `${formatMultiplier(lo)}–${formatMultiplier(hi).slice(1)}`;
}

/**
 * The list for one surface: Automatic first, then each row the server sent with a multiplier for this surface. Chat
 * leaves out a row that cannot run chat's tools (the server refuses it there). A row without a finite positive
 * multiplier is left out rather than shown with a guessed one.
 */
export function pickerOptions(view: ModelsView, surface: Surface, lang: "ar" | "en", autoLabel: string): PickerOption[] {
  const auto: PickerOption = { id: null, label: autoLabel, tier: null, china: false, multiplier: null, units: null };
  const rows = view.models.flatMap((r): PickerOption[] => {
    if (surface === "chat" && !r.tools) return [];
    const x = surface === "generate" ? generateMultiplier(view, r.id) : usable(own(view.multipliers.chat, r.id)) ? formatMultiplier(own(view.multipliers.chat, r.id)!) : null;
    if (x === null) return [];
    const u = surface === "chat" ? own(view.chatUnits, r.id) : undefined;
    return [{ id: r.id, label: r.label[lang], tier: r.tier, china: r.hosting === "china", multiplier: x, units: typeof u === "number" && Number.isFinite(u) ? u : null }];
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

/**
 * One answer per refusal. `confirming`: the request was the China confirmation, which only the owner may give. A lock
 * not taken in time is 503 `busy` for the conversation's and the brand's pick alike (rule 906); a 409 `busy` still reads
 * as busy, which is what a server older than that change answered for a brand pick.
 */
export function pickRefusal(status: number, error: unknown, confirming: boolean): Refusal {
  if (status === 401) return "signed_out";
  if (error === "unknown_model" || error === "not_pickable" || error === "china_unconfirmed") return "unavailable";
  if (status === 503 || error === "busy") return "busy";
  if (status === 404 || error === "not_found") return "not_found";
  if (status === 403) return confirming ? "owner_only" : "forbidden";
  if (status === 429) return "slow_down";
  return "failed";
}

/**
 * Send the bodies in order and stop at the first refusal (a refused confirmation never sends the pick). `why` null: all
 * landed, and `body` is the last answer (the pick's), passed through as it came; on a refusal `body` is that answer.
 */
export async function sendPick(bodies: readonly PickBody[], send: (b: PickBody) => Promise<{ status: number; body?: unknown }>): Promise<{ why: Refusal | null; body: unknown }> {
  let body: unknown = null;
  for (const b of bodies) {
    let r: { status: number; body?: unknown };
    try {
      r = await send(b);
    } catch {
      return { why: "failed", body: null };
    }
    body = r.body ?? null;
    if (r.status < 200 || r.status >= 300) return { why: pickRefusal(r.status, isObj(body) ? body.error : undefined, "confirmChina" in b), body };
  }
  return { why: null, body };
}

/**
 * The account's chat status as `PUT /api/models` answers it after a conversation pick: `chatStatus` worked out on the
 * server for the model that conversation now runs on. The same shape as `ChatStatus` (src/lib/chat-allowance.ts, a
 * server module this file may not import; tests/model-picker-copy.test.ts checks the two agree both ways).
 */
export type PickedChat = {
  used: number;
  allowance: number;
  left: number;
  counted: number;
  period: "trial" | "month";
  overflow: { on: boolean; available: boolean; used: number; credits: number; hold: number };
};

const nums = (o: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));

/** The `chat` of a pick's answer when it has the server's shape, else null (the allowance line then keeps what it shows). */
export function pickedChat(body: unknown): PickedChat | null {
  if (!isObj(body) || !isObj(body.chat)) return null;
  const c = body.chat;
  if (!nums(c, ["used", "allowance", "left", "counted"]) || (c.period !== "trial" && c.period !== "month")) return null;
  const o = c.overflow;
  if (!isObj(o) || typeof o.on !== "boolean" || typeof o.available !== "boolean" || !nums(o, ["used", "credits", "hold"])) return null;
  return c as PickedChat;
}

/** How long a refusal note stays under the picker before it goes away by itself (it also goes on Escape and the next pick). */
export const NOTE_MS = 8_000;

/** A conversation as the picker needs it: its id and its stored pick. */
export type ConvPickRow = { id: string; model?: string | null };

/** The picks made in this chat panel, by conversation id; null: cleared here (Automatic). */
export type MadePicks = Readonly<Record<string, string | null>>;

/**
 * The stored pick of conversation `conv`, latest first: a pick made in this panel, then the active conversation's record
 * as the chat page read it on the server (so a conversation older than the hundred newest listed still shows its own
 * pick), then the listed rows (`GET /api/conversations`).
 */
export function storedPick(conv: string, made: MadePicks, active: ConvPickRow | null | undefined, listed: readonly ConvPickRow[]): string | undefined {
  if (Object.prototype.hasOwnProperty.call(made, conv)) return made[conv] ?? undefined;
  if (active && active.id === conv) return active.model ?? undefined;
  return listed.find((c) => c.id === conv)?.model ?? undefined;
}

/**
 * Whether choosing `id` changes what is stored. Compared with the stored value itself, not with the entry shown: a stored
 * id the list no longer offers shows as Automatic, and choosing Automatic then sends null, which clears the stale record.
 */
export const pickChanges = (stored: unknown, id: string | null): boolean => (typeof stored === "string" ? stored : null) !== id;

/**
 * Whether the chat picker takes no pick now: while its own pick is being saved, while a message of the panel is in flight
 * (that reply's chat status arrives after the pick's and would overwrite the new model's ceiling with the old one's), and
 * before the list has loaded, unless loading failed (the trigger then opens to say so).
 */
export const pickerLocked = (s: { picking: boolean; replying: boolean; loaded: boolean; failed: boolean }): boolean => s.picking || s.replying || (!s.loaded && !s.failed);

/** One step of a pick: "pending" before the answer, null when it landed, else the refusal. */
export type PickOutcome = "pending" | Refusal | null;

/**
 * The panel's picks after one step of a pick on `conv`: shown at once, kept when it landed, and on a refusal `previous`
 * put back on that same conversation. Only `conv` changes, so a refusal that arrives after the person moved to another
 * conversation restores the one the pick was for, never the one open now.
 */
export function nextMadePicks(made: MadePicks, conv: string, previous: string | null, model: string | null, outcome: PickOutcome): MadePicks {
  return { ...made, [conv]: outcome === "pending" || outcome === null ? model : previous };
}

/** The brand field: the stored pick (`saved`) and the person's unsaved choice (`choice`, undefined: none). */
export type BrandPick = { saved: string | null; choice: string | null | undefined };

/**
 * The brand field after one step of a save: saved at once, kept when it landed; on a refusal the saved value goes back to
 * `previous` and the choice stays selected so Save can be pressed again, unless the list no longer offers it.
 */
export function nextBrandPick(previous: string | null, model: string | null, outcome: PickOutcome): BrandPick {
  if (outcome === "pending" || outcome === null) return { saved: model, choice: undefined };
  return { saved: previous, choice: outcome === "unavailable" ? undefined : model };
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
