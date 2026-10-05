/**
 * The follow-up after a meeting (Reem phase 3 B2b): tasks proposed for a booking item, and the one path that turns the
 * owner's pick of them into items. Server only.
 *
 * Rules held in code, not in prompts:
 * - The model never creates an item. Whatever proposes (later: Reem's chat tool, the notes and transcript routes) only
 *   stores a pending set with `savePending`. `approveMeeting` is the only creating path, and it runs for a signed-in
 *   login with `todo.write` (the approve route). A transcript that says "approve everything" changes nothing.
 * - The pending set is `sec:mprop:{scope}:{itemId}`, 14 days, at most 10 proposals `{ ref, title, agent, dueAt? }`. The
 *   scope is the caller's own (`sc`), never a request value; the item id from a request is format-checked and must be a
 *   live (not deleted) `booking` item of that scope, else it is "not found". Account deletion removes every set
 *   (`secretaryKeys`, through the `sec:mprops` index).
 * - `cleanProposals` takes untrusted data (a model's output) and never throws: it drops what fails the limits (not a
 *   list; more than 10; an agent that is neither an agent id nor "owner"; a day that is not a real local day from today
 *   to 366 days ahead keeps the entry without a date; duplicates) and cuts a title at 120 characters after `cleanLine`.
 *   The `ref` is made here, never taken from the input, and is new on every run, so a stale card can never approve what
 *   a later run proposed.
 * - `approveMeeting` creates only refs that are in the stored set, under one lock per scope and item
 *   (`sec:lock:{scope}:mprop:{itemId}`, 60 s), reading the set inside the lock and dropping it there: two clicks create
 *   each item once. `savePending` and `dropPending` (so a re-run and the discard route) take the same lock, so neither is
 *   undone by an approve that read the set earlier; inside the approve the unlocked internals are used (`withLock` is
 *   not reentrant). The owner's edits (title, agent, day) are checked by the same limits and refused, not trimmed; a
 *   refusal creates nothing and leaves the set as it was.
 * - Approve is idempotent through errors: before anything is created each kept proposal gets the id its item will have
 *   and the set is stored with it; items are made with that id and an id that already exists counts as made, so a retry
 *   after a failed write or a dead process never makes an item twice. Each create catches its own error, so no worker
 *   outlives the lock. If an item cannot be created part-way (the account's daily allowance, the 500 open items, a
 *   failed write), the ones made are reported with the refusal, and only the others stay pending.
 * - An agent task is an agent-owed handoff item (`agentTaskItem`, src/lib/secretary-handoff.ts): `waiting_on`,
 *   `they_owe`, `owedBy` the agent, `owedTo` the owner, `source: "agent"`, `handoffFrom: "reem"`. The agent does not run
 *   it and nothing is charged: no credit moves and no model is called here. An owner task is `task`, `i_owe`.
 * - Every description names its meeting. The booking title comes from outside a Thakeen account (the booker's name): it is
 *   cleaned with `cleanLine` and cut before it goes into a description.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { pmap } from "./parallel";
import { sc, type User } from "./auth";
import { isAgentId, type AgentId } from "./agents";
import { SEC_ID, SEC_KEYS, calFor, cleanLine, createItem, fail, getItem, isLocalDay, newSecId, withLock, type SecFail, type Who } from "./secretary";
import { addDays, zoneDay, type SecItem } from "./secretary-agenda";
import { agentTaskItem } from "./secretary-handoff";
import type { Zone } from "./zones";

/**
 * `itemId` is the id the item will get, chosen by `approveMeeting` and stored before anything is created (a retry then finds
 * what was made and makes nothing twice). Never set by a proposer: `cleanProposals` does not make it.
 */
export type Proposal = { ref: string; title: string; agent: AgentId | "owner"; dueAt?: string; itemId?: string };
/** Proposals in one set, entries in one approval, characters in a title, days ahead a due day may be. */
export const MEET_MAX = 10;
export const MEET_TITLE_MAX = 120;
export const MEET_DAYS_AHEAD = 366;
/** A pending set lives 14 days. */
export const MEET_PENDING_TTL_S = 14 * 86400;
/** How many entries of an untrusted list are looked at: a list of junk costs a bounded loop. */
const SCAN_MAX = 200;

/** Cut to `n` UTF-16 units without leaving half a surrogate pair, and without a trailing space. */
const cut = (s: string, n: number) => {
  let t = s.slice(0, n);
  if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1);
  return t.trimEnd();
};
const agentOf = (v: unknown): AgentId | "owner" | null => (v === "owner" ? "owner" : isAgentId(v) ? v : null);
/** A real local day from today to `MEET_DAYS_AHEAD` days ahead, in the brand's zone. */
const dayInRange = (v: unknown, now: number, zone: Zone): v is string => {
  if (!isLocalDay(v)) return false;
  const t = zoneDay(now, zone);
  return v >= t && v <= addDays(t, MEET_DAYS_AHEAD);
};
const newRef = (taken: Set<string>) => {
  let r = `m${randomBytes(4).toString("hex")}`;
  while (taken.has(r)) r = `m${randomBytes(4).toString("hex")}`;
  return r;
};

/**
 * What survives of untrusted data as proposals, in order, at most `MEET_MAX`. Never throws. `nowMs` and `zone` set which
 * local days are acceptable (the brand's zone).
 */
export function cleanProposals(raw: unknown, nowMs: number, zone: Zone): Proposal[] {
  const out: Proposal[] = [];
  const seen = new Set<string>();
  const refs = new Set<string>();
  try {
    if (!Array.isArray(raw)) return out;
    const n = Math.min(raw.length, SCAN_MAX);
    for (let i = 0; i < n && out.length < MEET_MAX; i++) {
      try {
        const e: unknown = raw[i];
        if (!e || typeof e !== "object" || Array.isArray(e)) continue;
        const { title: t, agent: a, dueAt: d } = e as Record<string, unknown>;
        if (typeof t !== "string") continue;
        const agent = agentOf(a);
        if (!agent) continue;
        const title = cut(cleanLine(t), MEET_TITLE_MAX);
        if (!title) continue;
        const key = `${agent}|${title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ref = newRef(refs);
        refs.add(ref);
        out.push({ ref, title, agent, ...(dayInRange(d, nowMs, zone) ? { dueAt: d } : {}) });
      } catch {
        // an entry that throws when read is data we do not trust: left out
      }
    }
  } catch {
    // a list that throws when read: what was kept so far
  }
  return out;
}

/** A stored set as it is read back: stored data is data, so each entry is checked and a malformed one is left out. */
function readSet(v: unknown): Proposal[] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.flatMap((e): Proposal[] => {
    if (!e || typeof e !== "object") return [];
    const { ref, title, agent, dueAt } = e as Record<string, unknown>;
    const a = agentOf(agent);
    const itemId = (e as Record<string, unknown>).itemId;
    return typeof ref === "string" && typeof title === "string" && title && a ? [{ ref, title, agent: a, ...(typeof dueAt === "string" && isLocalDay(dueAt) ? { dueAt } : {}), ...(typeof itemId === "string" && SEC_ID.test(itemId) ? { itemId } : {}) }] : [];
  }).slice(0, MEET_MAX);
  return ok.length ? ok : null;
}

/** The pending set of one item of the scope, or null. The id is format-checked before a key is built. */
export async function getPending(scope: string, itemId: string): Promise<Proposal[] | null> {
  if (!SEC_ID.test(itemId)) return null;
  return readSet(await db.get<unknown>(SEC_KEYS.mprop(scope, itemId)));
}

/** The lock of one item's pending set: the one `approveMeeting` holds while it creates. `withLock` is not reentrant. */
const setLock = <T>(scope: string, itemId: string, fn: () => Promise<T>) => withLock(scope, `mprop:${itemId}`, fn);

async function putPending(scope: string, itemId: string, p: Proposal[]): Promise<void> {
  if (!p.length) return delPending(scope, itemId);
  await db.sadd(SEC_KEYS.mprops(scope), itemId);
  await db.set(SEC_KEYS.mprop(scope, itemId), p.slice(0, MEET_MAX), MEET_PENDING_TTL_S);
}
async function delPending(scope: string, itemId: string): Promise<void> {
  await Promise.all([db.del(SEC_KEYS.mprop(scope, itemId)), db.srem(SEC_KEYS.mprops(scope), itemId)]);
}

/**
 * Store a pending set for an item (replacing any), for 14 days. The id goes into the scope's index first, so account
 * deletion finds the key. An empty list clears the set. Nothing here makes an item. Taken under the approve lock, so a
 * re-run that lands while an approve is creating is written after it, never lost to it; a `SecFail` (`lock_timeout`) when
 * the lock could not be had, nothing written.
 */
export async function savePending(scope: string, itemId: string, p: Proposal[]): Promise<SecFail | void> {
  if (!SEC_ID.test(itemId)) return;
  return setLock(scope, itemId, () => putPending(scope, itemId, p));
}

/** Discard the pending set of an item. Idempotent. Under the approve lock like `savePending`. */
export async function dropPending(scope: string, itemId: string): Promise<SecFail | void> {
  if (!SEC_ID.test(itemId)) return;
  return setLock(scope, itemId, () => delPending(scope, itemId));
}

/** The item when it is a live (not deleted) booking item of this scope, else null: what every meeting route and approve require. */
export async function liveBooking(scope: string, itemId: string): Promise<SecItem | null> {
  const it = await getItem(scope, itemId);
  return it && !it.deletedAt && it.source === "booking" ? it : null;
}

/** How long the approve lock lives: up to 10 creates in 4 parallel lanes, each a few Redis commands, with room for a slow store. */
const MEET_LOCK_S = 60;
export type ApproveFail = SecFail & { created?: string[] };
export type Approved = { ok: true; created: string[] };

/** One entry of what the owner kept, checked: the stored proposal with the owner's edits, or the refusal. Nothing is trimmed. */
function pick(e: unknown, byRef: Map<string, Proposal>, taken: Set<string>, now: number, zone: Zone): Proposal | SecFail {
  if (!e || typeof e !== "object" || Array.isArray(e)) return fail("bad_request", 400, "kept");
  const o = e as Record<string, unknown>;
  const base = typeof o.ref === "string" ? byRef.get(o.ref) : undefined;
  if (!base) return fail("not_found", 404, "ref");
  if (taken.has(base.ref)) return fail("bad_request", 400, "ref");
  taken.add(base.ref);
  const next: Proposal = { ref: base.ref, title: base.title, agent: base.agent, ...(base.dueAt ? { dueAt: base.dueAt } : {}) };
  if (o.title !== undefined) {
    if (typeof o.title !== "string") return fail("bad_text", 400, "title");
    const t = cleanLine(o.title);
    if (!t) return fail("title_required", 400, "title");
    if (t.length > MEET_TITLE_MAX) return fail("too_long", 400, "title");
    next.title = t;
  }
  if (o.agent !== undefined) {
    const a = agentOf(o.agent);
    if (!a) return fail("bad_party", 400, "agent");
    next.agent = a;
  }
  if (o.dueAt !== undefined) {
    if (o.dueAt === null || o.dueAt === "") delete next.dueAt;
    else if (!isLocalDay(o.dueAt)) return fail("bad_date", 400, "dueAt");
    else if (!dayInRange(o.dueAt, now, zone)) return fail("date_out_of_range", 400, "dueAt");
    else next.dueAt = o.dueAt;
  }
  return next;
}
const isPick = (v: Proposal | SecFail): v is Proposal => !("ok" in v);

/**
 * The owner approves some of an item's pending proposals. `kept` is `{ ref, title?, agent?, dueAt? }[]` (at most 10,
 * each ref once, each ref in the stored set; `dueAt: null` clears the day). Creates one item per kept entry in the
 * caller's scope and drops the set. See the module's rules for what is refused and what happens on a part-way failure.
 * `user` is the account that acts (its daily allowance is spent), `who` the login that pressed Approve.
 */
export async function approveMeeting(user: Pick<User, "email" | "scope">, itemId: string, kept: unknown, who: Who, now = Date.now()): Promise<Approved | ApproveFail> {
  const scope = sc(user as User);
  if (!SEC_ID.test(itemId)) return fail("not_found", 404);
  if (!Array.isArray(kept) || !kept.length) return fail("bad_request", 400, "kept");
  if (kept.length > MEET_MAX) return fail("too_many", 400, "kept");
  const { zone, cal } = await calFor(scope, now);
  const r = await withLock(scope, `mprop:${itemId}`, async (): Promise<Approved | ApproveFail> => {
    const [item, pending] = await Promise.all([liveBooking(scope, itemId), getPending(scope, itemId)]);
    if (!item || !pending) return fail("not_found", 404);
    const byRef = new Map(pending.map((p) => [p.ref, p]));
    const taken = new Set<string>();
    const chosen: Proposal[] = [];
    for (const e of kept) {
      const p = pick(e, byRef, taken, now, zone);
      if (!isPick(p)) return p;
      chosen.push(p);
    }
    const title = cut(cleanLine(item.title), MEET_TITLE_MAX);
    const description = /[؀-ۿ]/.test(title) ? `من اجتماع: ${title}` : `From the meeting: ${title}`;
    // Before anything is created, every kept proposal gets the id its item will have, and the set is stored with them: a
    // retry after an error (or a process that died) finds what was made by its id and makes nothing twice.
    const ids = new Map(chosen.map((p) => [p.ref, byRef.get(p.ref)?.itemId ?? newSecId()]));
    const withIds = pending.map((p) => (ids.has(p.ref) ? { ...p, itemId: ids.get(p.ref) } : p));
    if (chosen.some((p) => byRef.get(p.ref)?.itemId === undefined)) {
      try {
        await putPending(scope, itemId, withIds);
      } catch (e) {
        console.error("meeting set store failed", e instanceof Error ? e.name : "error");
        return { ...fail("busy", 503), created: [] };
      }
    }
    // No worker outlives the lock: each create catches its own error, and pmap waits for all of them.
    const made = await pmap(chosen, async (p) => {
      const id = ids.get(p.ref) as string;
      try {
        if (await getItem(scope, id)) return { p, id, c: { ok: true } as const }; // made by an earlier try
        const fields = p.agent === "owner"
          ? { title: p.title, description, kind: "task", direction: "i_owe", ...(p.dueAt ? { dueAt: p.dueAt } : {}) }
          : agentTaskItem(p.agent, p.title, description, { owedTo: "owner", ...(p.dueAt ? { dueAt: p.dueAt } : {}) });
        const c = p.agent === "owner"
          ? await createItem(user, fields, { ...who, source: "owner" }, { zone, cal, id })
          : await createItem(user, fields, { ...who, source: "agent" }, { zone, cal, handoffFrom: "reem", id });
        return { p, id, c: c.ok ? ({ ok: true } as const) : c };
      } catch (e) {
        console.error("meeting item create failed", e instanceof Error ? e.name : "error");
        return { p, id, c: fail("busy", 503) };
      }
    }, 4);
    const created = made.flatMap((m) => (m.c.ok ? [m.id] : []));
    const bad = made.find((m) => !m.c.ok)?.c as SecFail | undefined;
    try {
      if (!bad) await delPending(scope, itemId);
      // Part-way: what was made stays made; only the proposals that were not made stay pending (with their ids).
      else if (created.length) {
        const done = new Set(made.filter((m) => m.c.ok).map((m) => m.p.ref));
        await putPending(scope, itemId, withIds.filter((p) => !done.has(p.ref)));
      }
    } catch (e) {
      // The set stays as stored, ids included: a retry finds the made items by id and makes them no more than once.
      console.error("meeting set update failed", e instanceof Error ? e.name : "error");
    }
    return bad ? { ...bad, created } : { ok: true, created };
  }, MEET_LOCK_S);
  return r;
}
