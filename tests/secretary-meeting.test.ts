import { afterEach, describe, expect, it } from "vitest";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { getUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { MIN_ROLE } from "@/lib/roles";
import { SEC_WRITES_PER_HOUR, SEC_KEYS, createItem, getItem, listOpenItems, removeBySystem, secretaryKeys } from "@/lib/secretary";
import { addDays, zoneDay, type SecItem } from "@/lib/secretary-agenda";
import { wipeAccount } from "@/lib/account";
import { AGENT_IDS } from "@/lib/agents";
import * as meetRoute from "@/app/api/secretary/meeting/[id]/route";
import * as approveRoute from "@/app/api/secretary/meeting/[id]/approve/route";
import { MEET_MAX, MEET_TITLE_MAX, approveMeeting, cleanProposals, dropPending, getPending, savePending, type Proposal } from "@/lib/secretary-meeting";

// Nothing here reaches a network or a model: B2b's approve and the two routes are plain code over the in-memory store.
const ZONE = "Asia/Riyadh" as const;
const OWNER = { actor: "owner", via: "web" } as const;
const TTL_14_DAYS = 14 * 86400;
const mem = () => (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; sets: Map<string, unknown>; lists: Map<string, unknown>; hashes?: Map<string, unknown>; zsets?: Map<string, unknown> } }).__nashrMem;
const memKeys = () => { const m = mem(); return [...m.kv.keys(), ...m.sets.keys(), ...m.lists.keys(), ...(m.hashes?.keys() ?? []), ...(m.zsets?.keys() ?? [])]; };
const today = () => zoneDay(Date.now(), ZONE);
const day = (n: number) => addDays(today(), n);

/** A live booking item for `u`'s scope, made as the booking webhook makes it. */
async function booking(u: User, title = "Meeting with Omar Example", source: SecItem["source"] = "booking"): Promise<SecItem> {
  const r = await createItem(u, { title }, { actor: "rule", via: "web", source });
  if (!r.ok) throw new Error(`could not make the item: ${r.error}`);
  return r.item;
}
const prop = (title: string, agent: string, dueAt?: string): Record<string, unknown> => ({ title, agent, ...(dueAt ? { dueAt } : {}) });
/** Store a pending set for an item through the real validation, and return it. */
async function pend(u: User, item: SecItem, raw: unknown[]): Promise<Proposal[]> {
  const ps = cleanProposals(raw, Date.now(), ZONE);
  expect(ps).toHaveLength(raw.length);
  await savePending(sc(u), item.id, ps);
  return ps;
}
const openCount = async (u: User) => (await listOpenItems(sc(u))).length;

afterEach(() => { (MIN_ROLE as Record<string, string>)["todo.write"] = "member"; });

describe("meeting proposals and approve (rules 600-603)", () => {
  it("rule 600: cleanProposals keeps at most 10, cuts titles at 120 after cleanLine, drops an unknown agent, a bad or far day and duplicates, and ignores any ref in the input", () => {
    const now = Date.now();
    const clean = (raw: unknown) => cleanProposals(raw, now, ZONE);

    // Anything that is not a list yields nothing, and nothing throws.
    for (const raw of [undefined, null, "send the deck", 7, true, {}, { length: 3, 0: prop("x", "owner") }]) expect(clean(raw)).toEqual([]);
    // Entries that are not objects, or whose fields throw, are dropped; the rest survive.
    const hostile = { get title(): string { throw new Error("boom"); }, agent: "owner" };
    const proxy = new Proxy({}, { get() { throw new Error("trap"); }, has() { throw new Error("trap"); }, ownKeys() { throw new Error("trap"); } });
    expect(clean([null, undefined, "x", 5, [], hostile, proxy, prop("Keep me", "owner")]).map((p) => p.title)).toEqual(["Keep me"]);

    // At most 10, in order, counted after the dropped ones.
    const twelve = Array.from({ length: 12 }, (_, i) => prop(`Task number ${i + 1}`, "owner"));
    expect(MEET_MAX).toBe(10);
    expect(clean(twelve).map((p) => p.title)).toEqual(twelve.slice(0, 10).map((p) => p.title));
    expect(clean([prop("", "owner"), prop("   ", "owner"), { agent: "owner" }, ...twelve]).map((p) => p.title)).toEqual(twelve.slice(0, 10).map((p) => p.title));

    // The title is cleaned like any line (controls, new lines and runs of space), then cut at 120, never longer.
    expect(MEET_TITLE_MAX).toBe(120);
    expect(clean([prop("  Send\nthe   deck​\t to Omar ", "owner")])[0].title).toBe("Send the deck to Omar");
    expect(clean([prop("w".repeat(150), "owner")])[0].title).toBe("w".repeat(MEET_TITLE_MAX));
    // a cut never leaves a trailing space
    const long = clean([prop(`${"abc ".repeat(60)}end`, "owner")])[0].title;
    expect(long.length).toBeLessThanOrEqual(MEET_TITLE_MAX);
    expect(long.length).toBeGreaterThanOrEqual(MEET_TITLE_MAX - 1);
    expect(long).toBe(long.trim());
    expect(long.startsWith("abc abc abc")).toBe(true);
    // a cut never leaves half a surrogate pair
    expect(clean([prop("x".repeat(MEET_TITLE_MAX - 1) + "😀😀", "owner")])[0].title).toBe("x".repeat(MEET_TITLE_MAX - 1));

    // The agent must be an agent id or "owner", exactly; anything else drops the entry.
    expect(clean([prop("A", "mallory"), prop("B", ""), { title: "C" }, { title: "D", agent: 5 }, { title: "E", agent: ["reem"] }, { title: "F", agent: "__proto__" }])).toEqual([]);
    expect(clean(AGENT_IDS.map((a) => prop(`for ${a}`, a)).concat(prop("mine", "owner"))).map((p) => p.agent)).toEqual([...AGENT_IDS, "owner"].slice(0, MEET_MAX));

    // A due day is a real local day from today to 366 days ahead; any other value keeps the entry without a date.
    const dates = [today(), day(1), day(366), day(367), day(-1), "2026-02-30", "2026-13-01", "10/10/2026", `${day(3)}T10:00:00Z`, 20261010];
    const got = clean(dates.map((d, i) => ({ title: `t${i}`, agent: "owner", dueAt: d })));
    expect(got).toHaveLength(dates.length);
    expect(got.map((p) => p.dueAt)).toEqual([today(), day(1), day(366), undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    const odd = clean([null, "", { d: 1 }, [day(1)]].map((d, i) => ({ title: `u${i}`, agent: "owner", dueAt: d })));
    expect(odd).toHaveLength(4);
    expect([...got, ...odd].every((p) => !("dueAt" in p) || typeof p.dueAt === "string")).toBe(true);
    expect(odd.every((p) => !("dueAt" in p))).toBe(true);

    // Duplicates: the same words and agent once (case and spaces ignored); the same words for another agent stay.
    const dup = clean([prop("Send the deck", "owner"), prop("send  the DECK", "owner"), prop("Send the deck", "noor"), prop("Send the deck", "noor", day(2))]);
    expect(dup.map((p) => `${p.agent}:${p.title}`)).toEqual(["owner:Send the deck", "noor:Send the deck"]);

    // The code assigns the ref: an input ref is ignored, refs are unique, and the entry carries only its four fields.
    const withRefs = clean([{ ref: "evil", title: "One", agent: "owner", extra: "x" }, { ref: "evil", title: "Two", agent: "owner" }, { ref: "__proto__", title: "Three", agent: "owner" }]);
    expect(withRefs).toHaveLength(3);
    expect(new Set(withRefs.map((p) => p.ref)).size).toBe(3);
    for (const p of withRefs) {
      expect(p.ref).toMatch(/^m[a-f0-9]{8}$/);
      expect(Object.keys(p).sort()).toEqual(["agent", "ref", "title"]);
    }
    // a second run gives new refs for the same words: a stale card can never approve what a later run proposed
    expect(clean([prop("One", "owner")])[0].ref).not.toBe(withRefs[0].ref);
  });

  it("rule 601: pending is stored per scope and item with a 14-day TTL; another scope's item id reads nothing and answers 404; an item that is not a live booking item answers 404", async () => {
    const u = await newUser("mt601");
    const stranger = await newUser("mt601s");
    const scope = sc(u);
    const item = await booking(u);
    const ps = cleanProposals([prop("Send the deck", "owner", day(2)), prop("Draft the follow-up email", "noor")], Date.now(), ZONE);

    expect(await getPending(scope, item.id)).toBeNull();
    await savePending(scope, item.id, ps);
    const key = `sec:mprop:${scope}:${item.id}`;
    expect(await db.get(key)).not.toBeNull();
    const ttl = await db.ttl(key);
    expect(ttl).toBeGreaterThan(TTL_14_DAYS - 10);
    expect(ttl).toBeLessThanOrEqual(TTL_14_DAYS);
    expect(await getPending(scope, item.id)).toEqual(ps);
    // saving again replaces the set (a re-run), and refreshes the lifetime
    const next = cleanProposals([prop("Only this", "owner")], Date.now(), ZONE);
    await savePending(scope, item.id, next);
    expect(await getPending(scope, item.id)).toEqual(next);
    await savePending(scope, item.id, ps);
    // another scope reads nothing for this item id, and its own key names differ
    expect(await getPending(sc(stranger), item.id)).toBeNull();
    expect(await db.get(`sec:mprop:${sc(stranger)}:${item.id}`)).toBeNull();
    // a bad id reads nothing and builds no key
    expect(await getPending(scope, "../x")).toBeNull();

    // The read route: the owner sees the set; the stranger gets 404 for the same id, and nothing of the owner's titles.
    const read = (id: string) => meetRoute.GET(json(`/api/secretary/meeting/${id}`, "GET"), params({ id }));
    await signIn(u.email);
    const mine = await read(item.id);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ ok: true, proposals: ps });
    await signIn(stranger.email);
    const theirs = await read(item.id);
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).not.toContain("Send the deck");

    // 404 for anything that is not a live booking item of the caller's scope: a bad id, an unknown id, an item of another
    // source, and a booking item the owner deleted. Pending stored for them is never read.
    await signIn(u.email);
    const plain = await booking(u, "A hand-made item", "owner");
    const gone = await booking(u, "Meeting with Gone");
    await savePending(scope, plain.id, ps);
    await savePending(scope, gone.id, ps);
    expect(await removeBySystem(scope, gone.id, { actor: "rule", via: "web" }, "test")).toBe("deleted");
    for (const id of ["x", "../etc", "s0000000000000000", "S" + "a".repeat(16), plain.id, gone.id]) {
      const r = await read(id);
      expect(r.status, id).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: "not_found" });
    }
    // with nothing pending a live booking item reads an empty list
    const fresh = await booking(u, "Meeting with Fresh");
    const empty = await read(fresh.id);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ok: true, proposals: [] });

    // Account deletion leaves no pending set, whatever the item ids; another account's set stays.
    const keep = await newUser("mt601k");
    const keepItem = await booking(keep);
    await savePending(sc(keep), keepItem.id, ps);
    const w = await newUser("mt601w");
    const wi = await booking(w);
    const wj = await booking(w, "Meeting with Wipe Two");
    await savePending(sc(w), wi.id, ps);
    await savePending(sc(w), wj.id, ps);
    // an item hard-deleted from its indexes before the wipe leaves nothing behind either
    await db.srem(SEC_KEYS.all(sc(w)), wj.id);
    const named = await secretaryKeys(sc(w));
    expect(named).toEqual(expect.arrayContaining([`sec:mprop:${sc(w)}:${wi.id}`, `sec:mprop:${sc(w)}:${wj.id}`]));
    await wipeAccount(w.email);
    expect(memKeys().filter((k) => k.startsWith("sec:mprop") && k.includes(w.email))).toEqual([]);
    expect(await getPending(sc(keep), keepItem.id)).toEqual(ps);
  });

  it("rule 602: approve creates only the kept refs that are in the pending set; an edit with an unknown agent, a 121-character title or an 11th entry is refused and creates nothing; two concurrent approves create each item once; an agent task has direction they_owe, owedBy the agent, source agent and handoffFrom reem; nothing is charged", async () => {
    const u = await newUser("mt602");
    const scope = sc(u);
    const who = { ...OWNER, login: u.email };
    const meeting = await booking(u, "Meeting with Omar Example");
    const before = await openCount(u);
    const userBefore = JSON.stringify(await getUser(u.email));

    // Only the kept refs, as proposed: an agent task and an owner task, each naming the meeting.
    let ps = await pend(u, meeting, [prop("Send the pricing deck", "dana", day(3)), prop("Call Omar back", "owner"), prop("Draft the contract", "majed"), prop("Book the venue", "owner", day(10))]);
    const r1 = await approveMeeting(u, meeting.id, [{ ref: ps[0].ref }, { ref: ps[1].ref }], who);
    expect(r1.ok).toBe(true);
    const created = r1.ok ? r1.created : [];
    expect(created).toHaveLength(2);
    const items = await Promise.all(created.map((id) => getItem(scope, id)));
    const agentTask = items.find((i) => i?.title === "Send the pricing deck")!;
    const ownerTask = items.find((i) => i?.title === "Call Omar back")!;
    expect(agentTask).toMatchObject({ kind: "waiting_on", direction: "they_owe", owedBy: "dana", owedTo: "owner", source: "agent", handoffFrom: "reem", allDay: true });
    expect(zoneDay(Date.parse(agentTask.dueAt!), ZONE)).toBe(day(3));
    expect(agentTask.description).toContain("Meeting with Omar Example");
    expect(ownerTask).toMatchObject({ kind: "task", direction: "i_owe", owedBy: "owner", source: "owner", dueAt: null });
    expect(ownerTask.description).toContain("Meeting with Omar Example");
    expect(await openCount(u)).toBe(before + 2);
    // the others are not created and the set is gone
    expect((await listOpenItems(scope)).map((i) => i.title).sort()).toEqual(["Call Omar back", "Meeting with Omar Example", "Send the pricing deck"]);
    expect(await getPending(scope, meeting.id)).toBeNull();
    // a second approve of the same refs finds nothing to approve
    const again = await approveMeeting(u, meeting.id, [{ ref: ps[0].ref }], who);
    expect(again).toMatchObject({ ok: false, error: "not_found" });
    expect(await openCount(u)).toBe(before + 2);

    // A booking title comes from outside: it is cleaned before it is put in a description.
    const odd = await booking(u, "Meeting with ‮Evil\nName​");
    const oddPs = await pend(u, odd, [prop("Follow up", "owner")]);
    const oddR = await approveMeeting(u, odd.id, [{ ref: oddPs[0].ref }], who);
    expect(oddR.ok).toBe(true);
    const oddItem = (await getItem(scope, oddR.ok ? oddR.created[0] : ""))!;
    expect(oddItem.description).not.toMatch(/[‮​\n]/);

    // Edits are applied and checked like proposals: the owner can change the title, the agent and the day...
    ps = await pend(u, meeting, [prop("Draft the proposal", "owner"), prop("Share the notes", "noor", day(4))]);
    const edited = await approveMeeting(u, meeting.id, [{ ref: ps[0].ref, title: "  Draft the\nproposal v2 ", agent: "razan", dueAt: day(5) }, { ref: ps[1].ref, agent: "owner", dueAt: null }], who);
    expect(edited.ok).toBe(true);
    const ed = await Promise.all((edited.ok ? edited.created : []).map((id) => getItem(scope, id)));
    expect(ed.find((i) => i?.title === "Draft the proposal v2")).toMatchObject({ kind: "waiting_on", owedBy: "razan", source: "agent", handoffFrom: "reem" });
    expect(ed.find((i) => i?.title === "Share the notes")).toMatchObject({ kind: "task", direction: "i_owe", dueAt: null });
    // ...and a title of exactly 120 characters is accepted
    ps = await pend(u, meeting, [prop("Short", "owner")]);
    const exact = await approveMeeting(u, meeting.id, [{ ref: ps[0].ref, title: "y".repeat(MEET_TITLE_MAX) }], who);
    expect(exact.ok).toBe(true);

    // Refusals create nothing and leave the pending set as it was.
    ps = await pend(u, meeting, [prop("Alpha task", "owner"), prop("Beta task", "dana")]);
    const base = await openCount(u);
    const refused: [string, unknown][] = [
      ["unknown ref", [{ ref: "mdeadbeef" }]],
      ["one good one unknown ref", [{ ref: ps[0].ref }, { ref: "mdeadbeef" }]],
      ["ref of another set", [{ ref: "__proto__" }, { ref: "constructor" }]],
      ["unknown agent", [{ ref: ps[0].ref, agent: "mallory" }]],
      ["agent not a string", [{ ref: ps[0].ref, agent: 3 }]],
      ["121-character title", [{ ref: ps[0].ref, title: "z".repeat(MEET_TITLE_MAX + 1) }]],
      ["title that cleans to nothing", [{ ref: ps[0].ref, title: " \n​ " }]],
      ["title not a string", [{ ref: ps[0].ref, title: 9 }]],
      ["far day", [{ ref: ps[0].ref, dueAt: day(400) }]],
      ["past day", [{ ref: ps[0].ref, dueAt: day(-1) }]],
      ["bad day", [{ ref: ps[0].ref, dueAt: "2026-02-30" }]],
      ["eleven entries", Array.from({ length: MEET_MAX + 1 }, () => ({ ref: ps[0].ref }))],
      ["the same ref twice", [{ ref: ps[0].ref }, { ref: ps[0].ref }]],
      ["not a list", { ref: ps[0].ref }],
      ["entries that are not objects", ["x", null, 3]],
      ["nothing kept", []],
      ["missing ref", [{ title: "x" }]],
    ];
    for (const [name, kept] of refused) {
      const r = await approveMeeting(u, meeting.id, kept, who);
      expect(r.ok, name).toBe(false);
      expect(await openCount(u), name).toBe(base);
      expect(await getPending(scope, meeting.id), name).toEqual(ps);
    }
    // the refusals are SecFail shapes with a status and an error name
    expect(await approveMeeting(u, meeting.id, [{ ref: ps[0].ref, agent: "mallory" }], who)).toMatchObject({ ok: false, status: 400 });
    expect(await approveMeeting(u, meeting.id, [{ ref: "mdeadbeef" }], who)).toMatchObject({ ok: false, error: "not_found" });

    // Another scope cannot approve this item, whatever refs it sends, and the owner's set is untouched.
    const stranger = await newUser("mt602s");
    expect(await approveMeeting(stranger, meeting.id, [{ ref: ps[0].ref }], { ...OWNER, login: stranger.email })).toMatchObject({ ok: false, error: "not_found" });
    expect(await openCount(stranger)).toBe(0);
    expect(await getPending(scope, meeting.id)).toEqual(ps);
    // an item that is not a live booking item is not approvable, though a set is stored under its id
    const plain = await booking(u, "A hand-made item", "owner");
    const plainPs = await pend(u, plain, [prop("Nope", "owner")]);
    expect(await approveMeeting(u, plain.id, [{ ref: plainPs[0].ref }], who)).toMatchObject({ ok: false, error: "not_found" });
    const doomed = await booking(u, "Meeting with Doomed");
    const doomedPs = await pend(u, doomed, [prop("Nope", "owner")]);
    await removeBySystem(scope, doomed.id, { actor: "rule", via: "web" }, "test");
    expect(await approveMeeting(u, doomed.id, [{ ref: doomedPs[0].ref }], who)).toMatchObject({ ok: false, error: "not_found" });
    expect(await approveMeeting(u, "not-an-id", [{ ref: "x" }], who)).toMatchObject({ ok: false, error: "not_found" });
    expect(await openCount(u)).toBe(base + 1); // the hand-made item above is open; the deleted one is not

    // Concurrency: two (and five) approves of the same set at once create each item once.
    for (const n of [2, 5]) {
      const cs = await pend(u, meeting, [prop(`Race one of ${n}`, "owner"), prop(`Race two of ${n}`, "faris"), prop(`Race three of ${n}`, "owner")]);
      const start = await openCount(u);
      const out = await Promise.all(Array.from({ length: n }, () => approveMeeting(u, meeting.id, cs.map((c) => ({ ref: c.ref })), who)));
      expect(out.filter((o) => o.ok)).toHaveLength(1);
      expect(out.filter((o) => !o.ok).every((o) => !o.ok && o.error === "not_found")).toBe(true);
      expect(await openCount(u)).toBe(start + 3);
      const titles = (await listOpenItems(scope)).map((i) => i.title).filter((t) => t.startsWith(`Race `) && t.endsWith(` of ${n}`));
      expect(titles.sort()).toEqual([`Race one of ${n}`, `Race three of ${n}`, `Race two of ${n}`]);
    }

    // A creation the account's allowance refuses part-way: the created ones are reported, and only the rest stay pending.
    const lim = await newUser("mt602l");
    const lm = await booking(lim);
    const lps = await pend(lim, lm, [prop("L one", "owner"), prop("L two", "owner"), prop("L three", "owner")]);
    await db.set(`rate:sec:create:${lim.email}`, 198, 86400);
    const part = await approveMeeting(lim, lm.id, lps.map((p) => ({ ref: p.ref })), { ...OWNER, login: lim.email });
    expect(part).toMatchObject({ ok: false, error: "too_many", status: 429 });
    const made = !part.ok ? (part as { created?: string[] }).created ?? [] : [];
    expect(made).toHaveLength(2);
    const left = (await getPending(sc(lim), lm.id)) ?? [];
    expect(left).toHaveLength(1);
    const madeTitles = (await Promise.all(made.map((id) => getItem(sc(lim), id)))).map((i) => i!.title);
    expect(left.map((p) => p.ref)).toEqual(lps.filter((p) => !madeTitles.includes(p.title)).map((p) => p.ref));
    expect(await openCount(lim)).toBe(1 + 2);

    // Nothing is charged: the account's record, credits included, is exactly what it was before the first approve.
    const userAfter = JSON.stringify(await getUser(u.email));
    expect(userAfter).toBe(userBefore);
  });

  it("rule 603: 401 anonymous, 403 where todo.write is missing, discard is idempotent, GET never reads another scope", async () => {
    const u = await newUser("mt603");
    const member = await newMember(u, "member");
    const stranger = await newUser("mt603s");
    const scope = sc(u);
    const item = await booking(u);
    const ps = await pend(u, item, [prop("Send the deck", "owner"), prop("Draft the brief", "noor")]);
    const base = await openCount(u);
    const URL = (id: string) => `/api/secretary/meeting/${id}`;
    const read = (id = item.id) => meetRoute.GET(json(URL(id), "GET"), params({ id }));
    const discard = (id = item.id) => meetRoute.DELETE(json(URL(id), "DELETE"), params({ id }));
    const approve = (body: unknown, id = item.id) => approveRoute.POST(json(`${URL(id)}/approve`, "POST", body), params({ id }));
    const keptAll = { kept: ps.map((p) => ({ ref: p.ref })) };

    // Anonymous: 401 on all three, before anything is read.
    signOut();
    for (const r of [await read(), await discard(), await approve(keptAll)]) {
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(await getPending(scope, item.id)).toEqual(ps);

    // todo.write missing: DELETE and approve are 403 and change nothing; the read gate is its own.
    await signIn(member.email);
    (MIN_ROLE as Record<string, string>)["todo.write"] = "owner";
    for (const r of [await discard(), await approve(keptAll)]) {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "forbidden" });
    }
    expect(await getPending(scope, item.id)).toEqual(ps);
    expect(await openCount(u)).toBe(base);
    expect((await read()).status).toBe(200);
    (MIN_ROLE as Record<string, string>)["todo.write"] = "member";

    // Another scope: GET, DELETE and approve of this item are all 404, and neither scope changes.
    await signIn(stranger.email);
    await pend(stranger, await booking(stranger, "Meeting with Theirs"), [prop("Their task", "owner")]);
    for (const r of [await read(), await discard(), await approve(keptAll)]) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: "not_found" });
    }
    expect(await getPending(scope, item.id)).toEqual(ps);
    expect(await openCount(u)).toBe(base);
    expect(await openCount(stranger)).toBe(1);

    // Bad ids are 404 on all three, whoever asks.
    await signIn(u.email);
    for (const id of ["x", "s123", "%2e%2e", "S0000000000000000"]) for (const r of [await read(id), await discard(id), await approve(keptAll, id)]) expect(r.status, id).toBe(404);

    // Bad bodies are 400 and create nothing; a good one creates the kept items for the signed-in scope.
    for (const body of [undefined, null, "x", [], {}, { kept: "a" }, { kept: [{ ref: "mdeadbeef" }] }]) {
      const r = await approve(body);
      expect([400, 404], JSON.stringify(body)).toContain(r.status);
      expect((await r.json()).ok).toBe(false);
    }
    expect(await openCount(u)).toBe(base);
    const ok = await approve({ kept: [{ ref: ps[1].ref, agent: "razan" }] });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.created).toHaveLength(1);
    expect(await getItem(scope, body.created[0])).toMatchObject({ title: "Draft the brief", owedBy: "razan", source: "agent", handoffFrom: "reem" });
    expect(await getPending(scope, item.id)).toBeNull();

    // Discard is idempotent: with a set, without one, twice, and on a live booking item that never had one.
    await pend(u, item, [prop("Again", "owner")]);
    for (let i = 0; i < 3; i++) {
      const r = await discard();
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      expect(await getPending(scope, item.id)).toBeNull();
    }
    const never = await booking(u, "Meeting with Never");
    expect((await discard(never.id)).status).toBe(200);
    expect(await openCount(u)).toBe(base + 1 + 1);
    // dropPending, the module's own, is idempotent too
    await dropPending(scope, item.id);
    await dropPending(scope, item.id);

    // The write bucket (`sec:write`, per account): past it, DELETE and approve are 429 and change nothing; GET has its own.
    await pend(u, item, [prop("Held back", "owner")]);
    await db.set(`rate:sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600);
    for (const r of [await discard(), await approve({ kept: [{ ref: "x" }] })]) {
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ ok: false, error: "too_many" });
    }
    expect((await read()).status).toBe(200);
    expect(await getPending(scope, item.id)).not.toBeNull();
    await db.del(`rate:sec:write:${u.email}`);
  });
});

