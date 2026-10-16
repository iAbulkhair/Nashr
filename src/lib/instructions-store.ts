import { randomBytes } from "crypto";
import { CAPS, db, pushCapped } from "./db";
import { isAgentId, type AgentId } from "./agents";
import { isBy, type By } from "./actor";
import { recordActivity, type ActivityVia } from "./activity";
import { pmap } from "./parallel";
import {
  INSTRUCTION_CHARS,
  MAX_REFS,
  PLATFORM_CHARS,
  PLATFORM_ITEMS,
  WORKSPACE_ITEMS,
  normalizeInstruction,
  screenInstruction,
  type InstructionLimits,
  type ScreenCode,
} from "./instructions-safety";
import { log } from "./log";

/**
 * The stored layers of agent instructions (spec 5.1): the platform's own (`skills:platform`) and one per brand workspace
 * (`skills:{scope}`, the scope from `sc(u)` and never from a request). Each layer holds the set that is live (`active`)
 * and the set being edited (`draft`); activating makes the draft the next numbered version and records a revision
 * (`skillshist:{scope}`), so every version can be put back and nothing is deleted.
 *
 * Writes follow `saveGovAs` (src/lib/governance.ts): read, check and write under `skillslock:{scope}`, so two writers
 * cannot activate one draft twice or record a before and after that never existed. A workspace change adds an activity
 * row for the owner and a row in the founder feed (`skills:feed`) that names the account, the version and the number of
 * items switched on, and never an instruction's text. A platform change adds neither: the admin route logs it.
 *
 * Every write checks the same hard limits again (length, count, screen, targets, plan limits), not only the form's save:
 * a restore, an activation and a chat apply read what is stored, and today's checks apply to it.
 */

/** The scope literal of the platform layer. It cannot be an account scope: those contain an "@". */
export const PLATFORM = "platform";

/** `media` = image and video prompts; `reviewer` and `judge` exist only on the platform layer. */
export type Target = AgentId | "media" | "reviewer" | "judge";
export type Instruction = {
  id: string;
  text: string;
  agents: "all" | Target[];
  on: boolean;
  /** Platform only: customers cannot override it. */
  lock?: boolean;
  /** Workspace only: names of workspace files attached as reference. */
  refs?: string[];
  src: "owner" | "chat" | "admin";
  at: string;
};
export type InstructionSet = { items: Instruction[]; v: number };
/**
 * `seq` is the edit counter (rule 954): every write of the layer (a draft save, a discard, an activation, a restore, a chat
 * apply) moves it one past the number an editor could hold, so a number an editor holds is never the number of a later
 * state. A layer stored before it has none and reads as its old token (`editBase`).
 */
export type Layer = { active: InstructionSet; draft: InstructionSet | null; at: string; by: By | null; seq?: number };
export type Revision = { id: string; v: number; at: string; by: By; before: InstructionSet; after: InstructionSet; rollbackOf?: string; note?: string };

/** One item as a form or the chat sends it. */
export type Draft = { text: string; agents: "all" | Target[]; on: boolean; lock?: boolean; refs?: string[]; id?: string };

export type StoreError = "busy" | "too_long" | "too_many" | "bad_target" | "instructions_limit" | "per_agent_plan" | "refs_plan" | "no_draft" | "not_found" | "stale" | ScreenCode;
type Fail = { ok: false; error: StoreError; index?: number };
type Done = { ok: true; layer: Layer; revision: Revision };

export const layerKey = (scope: string) => `skills:${scope}`;
const histKey = (scope: string) => `skillshist:${scope}`;
const lockKey = (scope: string) => `skillslock:${scope}`;
/** Where each imported reference file came from (Google Docs and Sheets, rule 956); written by instruction-refs.ts. */
export const refsKey = (scope: string) => `skillrefs:${scope}`;
const FEED = "skills:feed";
export const PAUSED = "skills:paused";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const histCap = (scope: string) => (scope === PLATFORM ? CAPS.skillsHistory : CAPS.skillsWsHistory);
const newId = () => randomBytes(6).toString("hex");
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{12}$/.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every key a scope owns, for the account wipe (`wipeAccount`). */
export const instructionKeys = (scope: string): string[] => [layerKey(scope), histKey(scope), lockKey(scope), refsKey(scope)];

const emptySet = (): InstructionSet => ({ items: [], v: 0 });
const emptyLayer = (): Layer => ({ active: emptySet(), draft: null, at: new Date(0).toISOString(), by: null });
const isSet = (v: unknown): v is InstructionSet => isObj(v) && Array.isArray(v.items) && typeof v.v === "number" && Number.isFinite(v.v);

/** The layer of one scope; an empty one when nothing is stored or what is stored is not a layer. */
export async function getLayer(scope: string): Promise<Layer> {
  return parseLayer(await db.get<Layer>(layerKey(scope)));
}

/** A stored value as a layer; an empty one when it is not a layer. Shared by `getLayer` and the render's batch read. */
export function parseLayer(l: unknown): Layer {
  if (!isObj(l) || !isSet(l.active) || !(l.draft === null || l.draft === undefined || isSet(l.draft))) return emptyLayer();
  return { active: l.active, draft: l.draft ?? null, at: typeof l.at === "string" ? l.at : emptyLayer().at, by: isBy(l.by) ? l.by : null, ...(typeof l.seq === "number" && Number.isSafeInteger(l.seq) && l.seq >= 0 ? { seq: l.seq } : {}) };
}

/**
 * The `base` an editor names when it saves the draft: the layer's edit counter, or for a layer stored before the counter
 * the draft's version (the live set's when there is no draft). Not the live version: that stays the plain numbering of
 * the history (v1, v2, ...) and may equal a number an old editor holds.
 */
export const editBase = (l: Layer): number => l.seq ?? l.draft?.v ?? l.active.v;

/** `fn` under the scope's write lock (40 tries, 50 ms apart, as `saveGovAs`), or `busy` when it stays taken for about two seconds. */
async function withLock<T>(scope: string, fn: () => Promise<T>): Promise<T | { ok: false; error: "busy" }> {
  const lock = lockKey(scope);
  // An owned lock: a writer whose 10 s TTL ran out releases nothing of the writer that took the lock after it.
  let token: string | null = null;
  for (let i = 0; i < 40 && !token; i++) {
    token = await db.lockOwned(lock, 10);
    if (!token) await sleep(50);
  }
  if (!token) return { ok: false, error: "busy" };
  try {
    return await fn();
  } finally {
    // As in saveGovAs: a failed release must not turn a saved change into an error. The 10 s TTL frees the lock.
    await db.unlockOwned(lock, token).catch((e) => log.error("instructions lock release failed", e));
  }
}

const charsFor = (platform: boolean) => (platform ? PLATFORM_CHARS : INSTRUCTION_CHARS);
const itemsFor = (platform: boolean) => (platform ? PLATFORM_ITEMS : WORKSPACE_ITEMS);

/** The targets of one item, or null when one is not allowed: `reviewer` and `judge` only on the platform, at least one target. */
function targetsOf(agents: unknown, platform: boolean): "all" | Target[] | null {
  if (agents === "all") return "all";
  if (!Array.isArray(agents) || !agents.length) return null;
  const out: Target[] = [];
  for (const t of agents) {
    const ok = isAgentId(t) || t === "media" || (platform && (t === "reviewer" || t === "judge"));
    if (!ok) return null;
    if (!out.includes(t as Target)) out.push(t as Target);
  }
  return out;
}

/** Names of workspace files: strings only, no repeats. More than `MAX_REFS` is the caller's error and checked before this. */
const cleanRefs = (refs: string[]): string[] => [...new Set(refs.filter((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 200))];

/** An item for storage from what a form or the chat sent, or the error and why. An empty text is `null`: the row is dropped. */
function buildItem(d: Draft, platform: boolean, existing: Instruction | undefined, taken: Set<string>, src: Instruction["src"]): Instruction | Omit<Fail, "ok"> | null {
  const text = normalizeInstruction(typeof d.text === "string" ? d.text : "");
  if (!text) return null;
  if (text.length > charsFor(platform)) return { error: "too_long" };
  const screen = screenInstruction(text);
  if (screen) return { error: screen };
  const agents = targetsOf(d.agents, platform);
  if (!agents) return { error: "bad_target" };
  const rawRefs = !platform && Array.isArray(d.refs) ? d.refs : [];
  if (rawRefs.length > MAX_REFS) return { error: "too_many" };
  const refs = cleanRefs(rawRefs);
  const lock = platform && d.lock === true;
  const on = d.on !== false;
  const id = isId(d.id) && !taken.has(d.id) ? d.id : newId();
  const same = existing && existing.text === text && existing.on === on && existing.lock === (lock || undefined) && JSON.stringify(existing.agents) === JSON.stringify(agents) && JSON.stringify(existing.refs ?? []) === JSON.stringify(refs);
  return {
    id,
    text,
    agents,
    on,
    ...(lock ? { lock: true } : {}),
    ...(refs.length ? { refs } : {}),
    src: existing?.src ?? src,
    at: same && existing ? existing.at : new Date().toISOString(),
  };
}
const isFail = (v: Instruction | Omit<Fail, "ok"> | null): v is Omit<Fail, "ok"> => !!v && "error" in v;

/** Today's hard limits on a stored set, checked again at activate, restore and apply (spec 6). */
function recheck(set: InstructionSet, platform: boolean): StoreError | null {
  if (set.items.length > itemsFor(platform)) return "too_many";
  for (const i of set.items) {
    if (typeof i.text !== "string" || i.text.length > charsFor(platform)) return "too_long";
    const screen = screenInstruction(i.text);
    if (screen) return screen;
    if (!targetsOf(i.agents, platform)) return "bad_target";
    if (i.refs && i.refs.length > MAX_REFS) return "too_many";
  }
  return null;
}

/**
 * What a plan allows (spec 9), counted on the items that are on: the number of them, per-agent targets and reference
 * files. An item that is switched off is kept and applied nowhere, so it is not counted.
 */
export function checkLimits(set: InstructionSet, limits: InstructionLimits): StoreError | null {
  const on = set.items.filter((i) => i.on);
  if (on.length > limits.max) return "instructions_limit";
  if (!limits.perAgent && on.some((i) => i.agents !== "all")) return "per_agent_plan";
  if (!limits.refs && on.some((i) => i.refs?.length)) return "refs_plan";
  return null;
}

/**
 * Save the draft: every item is normalized and checked, then the whole draft is replaced. The active set is untouched.
 * `index` is the position in `items` of the first one refused. A row with no text left after normalizing is dropped.
 *
 * `opts.base` is the version the editor was loaded at: the draft's `v`, or the live set's `v` when there was no draft, as
 * `getLayer` showed it. It is compared under the lock with what is stored now and a difference is `stale` (409): another
 * writer got in between (a chat apply adds an item to the live set and to the draft and moves both versions on; an
 * activation or a discard changes what the editor was based on), and a save of the old copy would drop that item and the
 * next activation would remove it from the live set. Expand step: a save with no `base` (a page loaded before this
 * check) is still accepted and replaces the draft as it always did; the page sends `base` from then on.
 */
export async function saveDraft(scope: string, items: Draft[], by: By, opts: { platform: boolean; base?: number }): Promise<{ ok: true; layer: Layer } | Fail> {
  if (!Array.isArray(items)) return { ok: false, error: "too_many" };
  if (items.length > itemsFor(opts.platform)) return { ok: false, error: "too_many" };
  return withLock(scope, async () => {
    const layer = await getLayer(scope);
    if (opts.base !== undefined && opts.base !== editBase(layer)) return { ok: false as const, error: "stale" as const };
    // An item keeps the source and the edit time it had when its id is the same and nothing in it changed.
    const known = new Map([...layer.active.items, ...(layer.draft?.items ?? [])].map((i) => [i.id, i]));
    const taken = new Set<string>();
    const out: Instruction[] = [];
    for (let index = 0; index < items.length; index++) {
      const d = items[index];
      const existing = isObj(d) && isId(d.id) ? known.get(d.id) : undefined;
      const built = isObj(d) ? buildItem(d, opts.platform, existing, taken, opts.platform ? "admin" : "owner") : { error: "bad_target" as const };
      if (built === null) continue;
      if (isFail(built)) return { ok: false as const, error: built.error, index };
      taken.add(built.id);
      out.push(built);
    }
    const at = new Date().toISOString();
    // Every save moves the edit counter on, so two tabs that loaded the same `base` cannot both save: the second finds a
    // newer counter and gets `stale`. The draft keeps the live version it was based on in `v`.
    const next: Layer = { active: layer.active, draft: { items: out, v: layer.active.v }, at, by, seq: editBase(layer) + 1 };
    await db.set(layerKey(scope), next);
    return { ok: true as const, layer: next };
  });
}

/** Drop the draft. The active set stays. */
export async function discardDraft(scope: string, by: By): Promise<{ ok: true; layer: Layer } | { ok: false; error: "busy" }> {
  return withLock(scope, async () => {
    const layer = await getLayer(scope);
    if (!layer.draft) return { ok: true as const, layer };
    const next: Layer = { active: layer.active, draft: null, at: new Date().toISOString(), by, seq: editBase(layer) + 1 };
    await db.set(layerKey(scope), next);
    return { ok: true as const, layer: next };
  });
}

/** The newest revisions of one scope, newest first. A row that cannot be read is skipped, not guessed at. */
export async function listHistory(scope: string): Promise<Revision[]> {
  const rows = await db.lrange(histKey(scope), 0, histCap(scope) - 1);
  return rows.flatMap((r) => {
    try {
      const v = JSON.parse(r) as Revision;
      return isObj(v) && isId(v.id) && typeof v.v === "number" && typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) && isBy(v.by) && isSet(v.before) && isSet(v.after) ? [v] : [];
    } catch {
      return [];
    }
  });
}

export type FeedAction = "activate" | "restore" | "apply";
/** One workspace change in the founder feed: who (the account), when, which version and how many items are on. Never text. */
export type FeedRow = { at: string; scope: string; email: string; action: FeedAction; v: number; count: number };
const FEED_ACTIONS: readonly string[] = ["activate", "restore", "apply"];
/** The account behind a scope: `email` or `email#brandId`. */
const emailOf = (scope: string) => (scope.includes("#") ? scope.slice(0, scope.indexOf("#")) : scope);

/** A workspace write must name its plan's limits (a type error without them); the platform layer has none. */
type Opts = ({ platform: true } | { platform: false; limits: InstructionLimits }) & { note?: string };

/**
 * Make `items` the next active version. Checked again here (limits of today's plan on a workspace), written with its
 * revision, the owner's activity row and the founder's feed row in one go; the draft stays as it is unless `draft` says.
 */
async function commit(scope: string, layer: Layer, items: Instruction[], by: By, opts: Opts, action: FeedAction, extra: { rollbackOf?: string; draft?: InstructionSet | null; via?: ActivityVia }): Promise<Done | Fail> {
  const before = layer.active;
  const after: InstructionSet = { items, v: before.v + 1 };
  const bad = recheck(after, opts.platform) ?? (!opts.platform ? checkLimits(after, opts.limits) : null);
  if (bad) return { ok: false, error: bad };
  const at = new Date().toISOString();
  const revision: Revision = { id: newId(), v: after.v, at, by, before, after, ...(extra.rollbackOf ? { rollbackOf: extra.rollbackOf } : {}), ...(opts.note ? { note: opts.note } : {}) };
  const next: Layer = { active: after, draft: "draft" in extra ? (extra.draft ?? null) : layer.draft, at, by, seq: editBase(layer) + 1 };
  const count = items.filter((i) => i.on).length;
  await Promise.all([
    db.set(layerKey(scope), next),
    pushCapped(histKey(scope), JSON.stringify(revision), histCap(scope)),
    ...(opts.platform
      ? []
      : [
          recordActivity(scope, [{ at, kind: "instructions_changed", by, via: extra.via ?? "app", count, note: `v${after.v}` }]),
          // The feed is the founder's overview: a failed write must not undo the change, as `recordActivity` never does.
          pushCapped(FEED, JSON.stringify({ at, scope, email: emailOf(scope), action, v: after.v, count } satisfies FeedRow), CAPS.skillsFeed).catch((e) => log.error("instructions feed failed", e)),
        ]),
  ]);
  return { ok: true, layer: next, revision };
}

/** Put the draft live as the next version. `no_draft` when there is none (so a second, simultaneous activation finds nothing to do). */
export async function activate(scope: string, by: By, opts: Opts): Promise<Done | Fail> {
  return withLock(scope, async () => {
    const layer = await getLayer(scope);
    if (!layer.draft) return { ok: false as const, error: "no_draft" as const };
    return commit(scope, layer, layer.draft.items, by, opts, "activate", { draft: null });
  });
}

/**
 * Put back the set as it was after revision `revisionId`, looked up only in this scope's own history. It goes through
 * today's checks and is a new version with `rollbackOf`: nothing is deleted. A draft in progress is kept.
 */
export async function restore(scope: string, revisionId: string, by: By, opts: Opts): Promise<Done | Fail> {
  const rev = isId(revisionId) ? (await listHistory(scope)).find((r) => r.id === revisionId) : undefined;
  if (!rev) return { ok: false, error: "not_found" };
  return withLock(scope, async () => {
    const layer = await getLayer(scope);
    return commit(scope, layer, rev.after.items, by, opts, "restore", { rollbackOf: rev.id });
  });
}

/**
 * Add one item to the live set as the next version (an applied chat proposal, spec 7). A draft in progress gets the same
 * item, so activating that draft later does not drop it. Workspace only.
 */
export async function appendActive(scope: string, d: Draft, by: By, opts: { limits: InstructionLimits; src: "chat" }): Promise<Done | Fail> {
  return withLock(scope, async () => {
    const layer = await getLayer(scope);
    // One id unique across the live set and the draft in progress, which both receive the item.
    const taken = new Set([...layer.active.items, ...(layer.draft?.items ?? [])].map((i) => i.id));
    // Neither set may pass the item cap: the draft would otherwise refuse to save as it is the next time it is edited.
    if (layer.active.items.length >= WORKSPACE_ITEMS || (layer.draft && layer.draft.items.length >= WORKSPACE_ITEMS)) return { ok: false as const, error: "too_many" as const };
    const made = buildItem(d, false, undefined, taken, opts.src);
    // A proposal with no text is not a proposal; the caller checks this first, so it is only a guard.
    if (made === null) return { ok: false as const, error: "too_long" as const };
    if (isFail(made)) return { ok: false as const, error: made.error };
    let id = made.id;
    while (taken.has(id)) id = newId();
    const built = { ...made, id };
    // The draft moves on with the live set (its `v` is the version it was based on), and the edit counter moves too, so an editor opened before this apply is stale (`saveDraft`).
    const draft = layer.draft ? { items: [...layer.draft.items, built], v: layer.active.v + 1 } : null;
    return commit(scope, layer, [...layer.active.items, built], by, { platform: false, limits: opts.limits }, "apply", { draft, via: "chat" });
  });
}

// The comparison is a pure module (instructions-diff.ts) so the page can use it in the browser; the store keeps exporting it.
export { diffSets } from "./instructions-diff";

/** The founder's switch: while on, no workspace layer is applied anywhere. */
export async function isPaused(): Promise<boolean> {
  // The client parses a stored "1" back as the number 1 (db.ts), so compare as text.
  return String(await db.get(PAUSED)) === "1";
}
export async function setPaused(on: boolean): Promise<void> {
  if (on) await db.set(PAUSED, "1");
  else await db.del(PAUSED);
}

/** The newest `n` feed rows, newest first (at most the cap). A row that is not a feed row is skipped. */
export async function listFeed(n: number = 100): Promise<FeedRow[]> {
  const k = Number.isFinite(n) ? Math.max(0, Math.min(CAPS.skillsFeed, Math.floor(n))) : 0;
  if (!k) return [];
  const rows = await db.lrange(FEED, 0, k - 1);
  return rows.flatMap((r) => {
    try {
      const v = JSON.parse(r) as FeedRow;
      return isObj(v) && typeof v.at === "string" && typeof v.scope === "string" && typeof v.email === "string" && FEED_ACTIONS.includes(v.action) && Number.isFinite(v.v) && Number.isFinite(v.count)
        ? [{ at: v.at, scope: v.scope, email: v.email, action: v.action, v: v.v, count: v.count }]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * The account wipe: take this email's rows out of the feed. Under the feed's own lock so two wipes do not read the same
 * list; each row is removed by its exact text (`lrem`), so a row pushed meanwhile is never touched. A lock that stays
 * taken throws: the wipe stops and a retry runs it again, like a link that could not be revoked.
 */
export async function removeFeedRowsFor(email: string): Promise<void> {
  const res = await withLock("feed", async () => {
    const rows = await db.lrange(FEED, 0, -1);
    const mine = new Set(
      rows.filter((r) => {
        try {
          return (JSON.parse(r) as { email?: unknown }).email === email;
        } catch {
          return false;
        }
      }),
    );
    await pmap([...mine], (r) => db.lrem(FEED, r));
    return { ok: true as const };
  });
  if (!res.ok) throw new Error("skills feed busy");
}
