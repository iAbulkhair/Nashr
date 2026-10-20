import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { json, markVerified, newMember as helperNewMember, newUser as helperNewUser, params, signIn, signOut } from "./helpers/session";
import { createUser, currentUser, getUser, saveUser } from "@/lib/auth";
import { saveBrands } from "@/lib/brands";
import { createMember, forceRemoveMember, getMember, leaveTeam, removeMember, saveMember, type Member } from "@/lib/team";
import { wipeAccount } from "@/lib/account";
import { updatePerson } from "@/lib/person";
import { ownerOf } from "@/lib/membership";
import { storedPersonId } from "@/lib/keys";
import * as resetRoute from "@/app/api/auth/reset/route";
import * as adminUserRoute from "@/app/api/admin/users/[email]/route";
import * as accountRoute from "@/app/api/account/route";
import { db } from "@/lib/db";
import { appOrigin } from "@/lib/origin";
import * as rate from "@/lib/rate";
import { can, MIN_ROLE } from "@/lib/roles";
import * as secretary from "@/lib/secretary";
import { SEC_KEYS } from "@/lib/secretary";
import type { SecItem } from "@/lib/secretary-agenda";
import { buildIcs, feedHolds, feedItems, icsFold } from "@/lib/secretary-feed";
import * as feedRoute from "@/app/api/secretary/feed/[token]/route";
import * as manageRoute from "@/app/api/secretary/feed/route";
import { appDict } from "@/lib/app-i18n";
import { CHAT_ALLOWANCE, PLAN_CREDITS, PLAN_PRICE_SAR, SELF_SERVE_PLANS, formatCount } from "@/lib/pricing";
import { formatWhen } from "@/lib/secretary-agenda";
import { FeedView, type FeedState } from "@/components/app/FeedCard";
import { createFeed, FEED_KEYS, FEED_TOKEN, getFeedStatus, hashFeedToken, resolveFeed, revokeFeed, revokeFeeds } from "@/lib/feed-token";

// Pins the legacy shape (multi-org M1): this file pins R1's feed links, made and checked by login (`createFeed(login)`, the
// `sec:feedof:{login}` pointer, the login's lock, `activebrand:{login}`), so its persons are legacy ones; the links of a
// `p_` person, per `(pid, aid)`, are pinned in tests/multi-org-links.test.ts (rule 2119). Each still holds a shadow membership.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

const FOUNDER = "founder-feed@test.example";
type Mem = { kv: Map<string, unknown>; lists: Map<string, unknown>; sets: Map<string, unknown>; hashes?: Map<string, unknown>; zsets?: Map<string, unknown> };
const mem = () => (globalThis as unknown as { __nashrMem: Mem }).__nashrMem;
/** Every key in the fake store, whatever its type. */
const memKeys = () => { const m = mem(); return [...m.kv.keys(), ...m.lists.keys(), ...m.sets.keys(), ...(m.hashes?.keys() ?? []), ...(m.zsets?.keys() ?? [])]; };
/** Every stored value in the fake store, serialised (sets and maps spread so their members are visible). */
const memValues = () => {
  const m = mem();
  const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x instanceof Map ? [...x.entries()] : x));
  return [...m.kv.values(), ...m.lists.values(), ...m.sets.values(), ...(m.hashes?.values() ?? []), ...(m.zsets?.values() ?? [])].map(ser);
};
/** The `sec:feed:*` records that belong to this login. */
const recordsOf = (login: string) => [...mem().kv.entries()].filter(([k, v]) => k.startsWith("sec:feed:") && (v as { login?: string }).login === login);
const resolveAs = async (email: string, opts: { imp?: string } = {}) => { await signIn(email, opts); return currentUser(); };

beforeAll(() => {
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  // As teams-core.test.ts: the founder is admitted by email, with no console key configured.
  vi.stubEnv("WAITLIST_ADMIN_KEY", "");
});

describe("feed token (rules 530-533)", () => {
  it("rule 530: only the SHA-256 of the token is stored, the plain token never", async () => {
    const login = (await newUser("feed")).email;
    const token = await createFeed(login, login, "ar");
    expect(token).toMatch(FEED_TOKEN);
    expect(hashFeedToken(token)).toMatch(/^[0-9a-f]{64}$/);
    const rec = await db.get(FEED_KEYS.rec(hashFeedToken(token)));
    expect(rec).toEqual({ login, scope: login, lang: "ar", createdAt: expect.any(String) });
    expect(Number.isNaN(Date.parse((rec as { createdAt: string }).createdAt))).toBe(false);
    expect(memKeys().filter((k) => k.includes(token))).toEqual([]);
    expect(memValues().filter((v) => v.includes(token))).toEqual([]);
    expect(await resolveFeed(token)).toEqual({ hash: hashFeedToken(token), rec });
    expect(await getFeedStatus(login)).toEqual({ exists: true, createdAt: (rec as { createdAt: string }).createdAt });
  });

  it("rule 530: a malformed token is refused without reading the store", async () => {
    const spy = vi.spyOn(db, "get");
    try {
      for (const bad of ["", "short", "x".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`]) expect(await resolveFeed(bad)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rule 531: renewing deletes the old record and sec:feedof keeps one per login", async () => {
    const login = (await newUser("feed")).email;
    const first = await createFeed(login, login, "en");
    const second = await createFeed(login, login, "en");
    expect(first).not.toBe(second);
    expect(await resolveFeed(first)).toBeNull();
    expect(await resolveFeed(second)).not.toBeNull();
    expect(await db.get(FEED_KEYS.of(login))).toBe(hashFeedToken(second));
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(first)))).toBeNull();
    expect(recordsOf(login)).toHaveLength(1);
  });

  it("rule 532: two creates at once leave exactly one working link; revoke is idempotent", async () => {
    const login = (await newUser("feed")).email;
    const out = await Promise.all([createFeed(login, login, "ar"), createFeed(login, login, "ar")]);
    expect(out.filter((x) => x === "busy").length).toBeLessThanOrEqual(1);
    expect(recordsOf(login)).toHaveLength(1);
    const working = await Promise.all(out.filter((x) => x !== "busy").map((t) => resolveFeed(t)));
    expect(working.filter((r) => r !== null)).toHaveLength(1);

    await revokeFeed(login);
    await revokeFeed(login);
    expect(recordsOf(login)).toEqual([]);
    expect(memKeys().filter((k) => k === FEED_KEYS.of(login))).toEqual([]);
    expect(await getFeedStatus(login)).toEqual({ exists: false, createdAt: null });
  });

  it("rule 532: a held lock never keeps a link alive, and revokeFeeds revokes every login given", async () => {
    const a = (await newUser("feed")).email;
    const b = (await newUser("feed")).email;
    const ta = await createFeed(a, a, "ar");
    const tb = await createFeed(b, b, "en");
    const held = await db.lockOwned(`lock:feed:${a}`, 10);
    expect(held).not.toBeNull();
    try {
      expect(await createFeed(a, a, "ar")).toBe("busy");
      await revokeFeeds([a, b]);
      expect(await resolveFeed(ta)).toBeNull();
      expect(await resolveFeed(tb)).toBeNull();
      expect(recordsOf(a)).toEqual([]);
      expect(recordsOf(b)).toEqual([]);
    } finally {
      await db.unlockOwned(`lock:feed:${a}`, held!);
    }
  });

  it("rule 532: a record that sec:feedof does not name is dead (a create that outran a revoke)", async () => {
    const login = (await newUser("feed")).email;
    const live = await createFeed(login, login, "ar");
    expect(live).toMatch(FEED_TOKEN);
    expect(await resolveFeed(live)).not.toBeNull();

    // What a stalled create leaves after a revoke that gave up waiting: its record written, `of` naming something else or nothing.
    const orphan = randomBytes(32).toString("base64url");
    await db.set(FEED_KEYS.rec(hashFeedToken(orphan)), { login, scope: login, lang: "ar", createdAt: new Date().toISOString() });
    expect(await resolveFeed(orphan)).toBeNull();
    expect(await resolveFeed(live)).not.toBeNull();

    await revokeFeed(login);
    expect(await db.get(FEED_KEYS.of(login))).toBeNull();
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(orphan)))).not.toBeNull();
    expect(await resolveFeed(orphan)).toBeNull();

    // Named by `of`, the same record works: the check is `of === hash`, nothing else.
    await db.set(FEED_KEYS.of(login), hashFeedToken(orphan));
    expect(await resolveFeed(orphan)).toEqual({ hash: hashFeedToken(orphan), rec: expect.objectContaining({ login }) });
  });

  it("rule 533: feed.manage is member-level and blocked while a founder impersonates", async () => {
    expect(MIN_ROLE["feed.manage"]).toBe("member");
    const owner = await newUser("feedown");
    const admin = await newMember(owner, "admin");
    const member = await newMember(owner, "member");
    expect(can(await resolveAs(owner.email), "feed.manage")).toBe(true);
    expect(can(await resolveAs(admin.email), "feed.manage")).toBe(true);
    expect(can(await resolveAs(member.email), "feed.manage")).toBe(true);
    const founder = await resolveAs(owner.email, { imp: FOUNDER });
    expect(founder!.actor).toMatchObject({ kind: "founder" });
    expect(can(founder, "feed.manage")).toBe(false);
  });
});

const DAY = 864e5;
const NOW = Date.parse("2026-10-05T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
/** One open item written straight to the store, so dueAt, updatedAt and rev are exact. */
async function seed(scope: string, o: Partial<SecItem> = {}): Promise<SecItem> {
  const id = o.id ?? `s${(++seq).toString(16).padStart(16, "0")}`;
  const it: SecItem = {
    id, kind: "task", title: `Item ${id}`, description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null,
    dueAt: null, allDay: false, snoozeUntil: null, priority: 0, critical: false, links: {}, source: "owner", notes: [],
    createdAt: iso(NOW), updatedAt: iso(NOW), completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, rev: 1, ...o,
  };
  await db.set(SEC_KEYS.item(scope, id), it);
  await db.zadd(SEC_KEYS.open(scope), it.dueAt ? Date.parse(it.dueAt) : Number.MAX_SAFE_INTEGER, id);
  return it;
}
const lines = (ics: string) => ics.split("\r\n");
const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const opts = { lang: "en" as const, zone: "Asia/Riyadh" as const, origin: "https://thakeen.example", now: NOW };

describe("feed content (rules 534-538)", () => {
  it("rule 534: only open dated items in the window, nearest first, 500 at most", async () => {
    const scope = "feed-t534";
    const old = await seed(scope, { dueAt: iso(NOW - 20 * DAY) });
    const recent = await seed(scope, { dueAt: iso(NOW - 10 * DAY) });
    const soon = await seed(scope, { dueAt: iso(NOW + 5 * DAY) });
    const far = await seed(scope, { dueAt: iso(NOW + 400 * DAY) });
    const undated = await seed(scope, { dueAt: null });
    const done = await seed(scope, { dueAt: iso(NOW + DAY), completedAt: iso(NOW) });
    const gone = await seed(scope, { dueAt: iso(NOW + DAY), deletedAt: iso(NOW) });
    const got = (await feedItems(scope, NOW)).map((i) => i.id);
    expect(got).toEqual([recent.id, soon.id]);
    for (const x of [old, far, undated, done, gone]) expect(got).not.toContain(x.id);

    const many = "feed-t534-many";
    const made = await Promise.all(Array.from({ length: 520 }, (_, i) => seed(many, { dueAt: iso(NOW + (i + 1) * 60_000) })));
    const all = await feedItems(many, NOW);
    expect(all).toHaveLength(500);
    expect(all.map((i) => i.id)).toEqual(made.slice(0, 500).map((i) => i.id));
  });

  it("rule 534: the window bounds are inclusive and one second outside is out", async () => {
    const scope = "feed-t534-bounds";
    const lo = await seed(scope, { dueAt: iso(NOW - 14 * DAY) });
    const hi = await seed(scope, { dueAt: iso(NOW + 365 * DAY) });
    await seed(scope, { dueAt: iso(NOW - 14 * DAY - 1000) });
    await seed(scope, { dueAt: iso(NOW + 365 * DAY + 1000) });
    expect((await feedItems(scope, NOW)).map((i) => i.id)).toEqual([lo.id, hi.id]);
  });

  it("rule 534: an item snoozed now is left out, as the to-do page hides it; one whose snooze ended is in; a proposed-done item is in", async () => {
    const scope = "feed-t534-snooze";
    const asleep = await seed(scope, { dueAt: iso(NOW + DAY), snoozeUntil: iso(NOW + 3600_000) });
    const woke = await seed(scope, { dueAt: iso(NOW + 2 * DAY), snoozeUntil: iso(NOW - 1000) });
    const proposed = await seed(scope, { dueAt: iso(NOW + 3 * DAY), snoozeUntil: iso(NOW + 3600_000), proposedDone: { at: iso(NOW), by: "reem", evidence: "done" } });
    const got = (await feedItems(scope, NOW)).map((i) => i.id);
    expect(got).toEqual([woke.id, proposed.id]);
    expect(got).not.toContain(asleep.id);
    // The page's own predicate: the same answer as `classify` for each item.
    const { classify } = await import("@/lib/secretary-agenda");
    for (const it of [asleep, woke, proposed]) expect(classify(it, NOW)?.bucket === "snoozed", it.id).toBe(it.id === asleep.id);
  });

  it("rule 535: a recurring series shows its one open copy; a ghost id in sec:open does not appear", async () => {
    const scope = "feed-t535";
    const copy = await seed(scope, {
      dueAt: iso(NOW + DAY), allDay: true, series: { id: "r0123456789abcdef0", n: 3 },
      repeat: { every: "week", interval: 1, anchor: "2026-10-06", weekStart: 0 },
    });
    const ghost = await seed(scope, { dueAt: iso(NOW + 2 * DAY), completedAt: iso(NOW) });
    const got = await feedItems(scope, NOW);
    expect(got.map((i) => i.id)).toEqual([copy.id]);
    const ics = buildIcs(got, opts);
    expect(lines(ics).filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(ics).not.toContain(ghost.id);
    expect(ics).not.toContain("RRULE");
  });

  it("rule 536: a timed item is UTC with a 30 minute end, an all-day item is a date in the brand zone", async () => {
    const scope = "feed-t536";
    const timed = await seed(scope, { dueAt: "2026-10-05T09:00:00.000Z", updatedAt: "2026-10-04T10:11:12.000Z", rev: 7 });
    const allDay = await seed(scope, { dueAt: "2026-10-05T20:59:00.000Z", allDay: true, updatedAt: "2026-10-03T01:02:03.000Z", rev: 2 });
    const ics = buildIcs(await feedItems(scope, NOW), opts);
    const events = ics.split("BEGIN:VEVENT\r\n").slice(1);
    const ev = (id: string) => events.find((e) => e.includes(`UID:${id}@thakeen\r\n`))!;
    const t = ev(timed.id);
    expect(t).toContain("DTSTART:20261005T090000Z\r\n");
    expect(t).toContain("DTEND:20261005T093000Z\r\n");
    expect(t).toContain("SEQUENCE:7\r\n");
    expect(t).toContain("DTSTAMP:20261004T101112Z\r\n");
    expect(t).toContain("LAST-MODIFIED:20261004T101112Z\r\n");
    expect(t).toContain("STATUS:CONFIRMED\r\n");
    const a = ev(allDay.id);
    expect(a).toContain("DTSTART;VALUE=DATE:20261005\r\n");
    expect(a).toContain("DTEND;VALUE=DATE:20261006\r\n");
    expect(a).toContain("SEQUENCE:2\r\n");
    expect(a).toContain("LAST-MODIFIED:20261003T010203Z\r\n");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("X-WR-CALNAME:Thakeen: my to-dos\r\n");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n");
    expect(ics).toContain("X-PUBLISHED-TTL:PT1H\r\n");
    expect(unfold(buildIcs([], { ...opts, lang: "ar" }))).toContain("X-WR-CALNAME:ذكين: مهامي\r\n");
  });

  it("rule 536: an all-day item past local midnight is the next local day, per the brand's zone", async () => {
    const scope = "feed-t536-zones";
    // 21:30 UTC is 00:30 on 6 Oct in Riyadh (+3), still 5 Oct in UTC.
    const riyadh = await seed(scope, { dueAt: "2026-10-05T21:30:00.000Z", allDay: true });
    // 20:30 UTC is 23:30 on 5 Oct in Riyadh (+3) but 00:30 on 6 Oct in Dubai (+4): same instant, the zone decides.
    const dubai = await seed(scope, { dueAt: "2026-10-05T20:30:00.000Z", allDay: true });
    const items = await feedItems(scope, NOW);
    const day = (zone: "Asia/Riyadh" | "Asia/Dubai", id: string) => {
      const ev = buildIcs(items, { ...opts, zone }).split("BEGIN:VEVENT\r\n").slice(1).find((e) => e.includes(`UID:${id}@thakeen\r\n`))!;
      return [ev.match(/DTSTART;VALUE=DATE:(\d+)/)![1], ev.match(/DTEND;VALUE=DATE:(\d+)/)![1]];
    };
    expect(day("Asia/Riyadh", riyadh.id)).toEqual(["20261006", "20261007"]);
    expect(day("Asia/Riyadh", dubai.id)).toEqual(["20261005", "20261006"]);
    expect(day("Asia/Dubai", dubai.id)).toEqual(["20261006", "20261007"]);
  });

  it("rule 537: no notes, description or phone in the body", async () => {
    const scope = "feed-t537";
    await seed(scope, {
      title: "Send the quote", description: "SECRET-DESC", phone: "966500000000", dueAt: iso(NOW + DAY),
      notes: [{ at: iso(NOW), by: "owner", text: "SECRET-NOTE", private: true }],
    });
    await seed(scope, { title: "Signed contract", direction: "they_owe", owedBy: "Sara", owedTo: "owner", dueAt: iso(NOW + 2 * DAY) });
    const items = await feedItems(scope, NOW);
    for (const lang of ["en", "ar"] as const) {
      const ics = unfold(buildIcs(items, { ...opts, lang }));
      for (const secret of ["SECRET-NOTE", "SECRET-DESC", "966500000000"]) expect(ics).not.toContain(secret);
      expect(ics).not.toMatch(/\b(SAR|USD)\b|ر\.س|ريال|\$/);
      const desc = lines(ics).filter((l) => l.startsWith("DESCRIPTION:"));
      expect(desc).toHaveLength(2);
      const url = `https://thakeen.example/${lang}/app/todo`;
      expect(desc[0]).toBe(`DESCRIPTION:${lang === "ar" ? "عليّ أنا" : "Mine"} - ${url}`);
      expect(desc[1]).toBe(`DESCRIPTION:${lang === "ar" ? "ننتظر Sara" : "Waiting on Sara"} - ${url}`);
      expect(ics).toContain(`URL:${url}`);
    }
  });

  it("rule 538: file safety", async () => {
    const scope = "feed-t538";
    const evil = "a,b;c\r\nEND:VEVENT\r\nBEGIN:VEVENT\u202e";
    const arabic = "مهمة ".repeat(40).trim();
    await seed(scope, { title: evil, dueAt: iso(NOW + DAY) });
    await seed(scope, { title: arabic, dueAt: iso(NOW + 2 * DAY) });
    const ics = buildIcs(await feedItems(scope, NOW), opts);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lines(ics).filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines(ics).filter((l) => l === "END:VEVENT")).toHaveLength(2);
    expect(ics).not.toContain("\u202e");
    expect(unfold(ics)).toContain("SUMMARY:a\\,b\\;c END:VEVENT BEGIN:VEVENT\r\n");
    for (const l of lines(ics)) expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    expect(Buffer.byteLength(`SUMMARY:${arabic}`, "utf8")).toBeGreaterThan(75);
    expect(unfold(ics)).toContain(`SUMMARY:${arabic}\r\n`);
    // folding directly: continuation lines start with one space and the text round-trips
    const folded = icsFold("X:" + "ع".repeat(100));
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe("X:" + "ع".repeat(100));
  });

  it("rule 538: every line-break, control and direction character is gone or a space, and a literal backslash-n stays text", async () => {
    const scope = "feed-t538-table";
    const chars: [number, string][] = [
      ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x0, 0x7f].map((c): [number, string] => [c, ""]),
      ...[0x2028, 0x2029, 0x85, 0x0d, 0x0a].map((c): [number, string] => [c, " "]),
    ];
    const rows = await Promise.all(chars.map(async ([c, repl]) => ({ c, repl, it: await seed(scope, { title: `x${String.fromCharCode(c)}y`, dueAt: iso(NOW + DAY) }) })));
    const slash = await seed(scope, { title: "a" + String.fromCharCode(0x5c) + "nb", dueAt: iso(NOW + DAY) });
    const ics = unfold(buildIcs(await feedItems(scope, NOW), opts));
    const summaryOf = (id: string) => {
      const ev = ics.split("BEGIN:VEVENT\r\n").slice(1).find((e) => e.includes(`UID:${id}@thakeen\r\n`))!;
      return ev.match(/^SUMMARY:(.*)\r$/m)![1];
    };
    for (const r of rows) expect(summaryOf(r.it.id), `U+${r.c.toString(16)}`).toBe(`x${r.repl}y`);
    expect(summaryOf(slash.id)).toBe("a" + String.fromCharCode(0x5c, 0x5c) + "nb");
    expect(lines(ics).filter((l) => l === "BEGIN:VEVENT")).toHaveLength(chars.length + 1);
    expect(lines(ics).filter((l) => l === "END:VEVENT")).toHaveLength(chars.length + 1);
  });

  it("rule 538: a caller-supplied origin cannot add a property line to URL or DESCRIPTION", async () => {
    const scope = "feed-t538-url";
    await seed(scope, { dueAt: iso(NOW + DAY) });
    const ics = buildIcs(await feedItems(scope, NOW), { ...opts, origin: "https://x.example\r\nX-INJECT:1" });
    expect(lines(unfold(ics)).filter((l) => l.startsWith("X-INJECT"))).toEqual([]);
    expect(unfold(ics)).toContain("URL:https://x.example X-INJECT:1/en/app/todo\r\n");
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("rule 538: an unparseable updatedAt does not fail the feed; it falls back to the due time", async () => {
    const scope = "feed-t538-stamp";
    const bad = await seed(scope, { dueAt: "2026-10-05T09:00:00.000Z", updatedAt: "not a date" });
    const good = await seed(scope, { dueAt: "2026-10-06T09:00:00.000Z" });
    const ics = buildIcs(await feedItems(scope, NOW), opts);
    const ev = (id: string) => ics.split("BEGIN:VEVENT\r\n").slice(1).find((e) => e.includes(`UID:${id}@thakeen\r\n`))!;
    expect(ev(bad.id)).toContain("DTSTAMP:20261005T090000Z\r\n");
    expect(ev(bad.id)).toContain("LAST-MODIFIED:20261005T090000Z\r\n");
    expect(ev(good.id)).toContain("DTSTAMP:20261005T080000Z\r\n");
  });
});

let ipN = 0;
/** A fresh client address per use, so the per-IP bucket of one test never touches another's. */
const nextIp = () => { const n = ++ipN; return `10.9.${n >> 8}.${n & 255}`; };
const callFeed = (token: string, ip = nextIp()) =>
  feedRoute.GET(new Request(`http://x/api/secretary/feed/${token}`, { headers: { "x-forwarded-for": ip } }), params({ token }));
const brandRows = (status: "active" | "archived") => [
  { id: "default", name: "", createdAt: iso(NOW), status: "active" as const },
  { id: "b2", name: "Two", createdAt: iso(NOW), status },
];

describe("public feed route (rules 539, 577-579)", () => {
  it("rule 539: malformed, unknown, revoked and no-longer-valid logins give the same empty 404, and a malformed token reads nothing", async () => {
    const ip = nextIp();
    const due = iso(Date.now() + DAY);
    const owner = await newUser("feed539");
    const revoked = await createFeed(owner.email, owner.email, "en");
    await revokeFeed(owner.email);

    const member = await newMember(owner, "member");
    await seed(owner.email, { dueAt: due });
    const removed = await createFeed(member.email, owner.email, "en");
    const sus = await newUser("feed539s");
    await seed(sus.email, { dueAt: due });
    const suspended = await createFeed(sus.email, sus.email, "en");
    const arch = await newUser("feed539a");
    await saveBrands(arch.email, brandRows("active"));
    await seed(`${arch.email}#b2`, { dueAt: due });
    const archived = await createFeed(arch.email, `${arch.email}#b2`, "en");
    // Each one works while its login and brand hold.
    for (const t of [removed, suspended, archived]) expect((await callFeed(t, ip)).status).toBe(200);

    // The member is removed the way dropMember does it (record and roster entry), without revoking the link: the stale
    // record must still be refused by the validity check alone.
    await Promise.all([db.del(`member:${member.email}`), db.srem(`members:${owner.email}`, member.email)]);
    await saveUser({ ...(await getUser(sus.email))!, suspended: true });
    await saveBrands(arch.email, brandRows("archived"));
    for (const t of [removed, suspended, archived]) {
      const found = await resolveFeed(t);
      expect(found).not.toBeNull();
      expect(await feedHolds(found!.rec)).toBe(false);
    }

    const responses: Response[] = [];
    const get = vi.spyOn(db, "get");
    const limit = vi.spyOn(rate, "allow");
    try {
      for (const bad of ["x", "a".repeat(44), ".ics"]) responses.push(await callFeed(bad, ip));
      expect(get).not.toHaveBeenCalled();
      expect(limit).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      limit.mockRestore();
    }
    for (const t of [randomBytes(32).toString("base64url"), revoked, removed, suspended, archived]) responses.push(await callFeed(t, ip));
    expect(responses).toHaveLength(8);
    const first = [...responses[0].headers];
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("");
      expect([...r.headers]).toEqual(first);
    }
  });

  it("rule 539: a member's link holds only while resolveSession would let that member in", async () => {
    const owner = await newUser("feed539m");
    const { email } = await newMember(owner, "admin");
    // Made after the member joined: a record from before the login's life is refused (the re-invite test below).
    const rec = { login: email, scope: owner.email, lang: "en" as const, createdAt: new Date(Date.now() + 1000).toISOString() };
    const original = (await getMember(email))!;
    const holdsWith = async (m: Partial<Member>) => {
      await saveMember({ ...original, ...m });
      try { return await feedHolds(rec); } finally { await saveMember(original); }
    };
    expect(await feedHolds(rec)).toBe(true);
    expect(await holdsWith({ disabled: "seats" })).toBe(false);
    expect(await holdsWith({ role: "owner" as Member["role"] })).toBe(false);
    expect(await holdsWith({ acceptedAt: iso(Date.parse(owner.createdAt) - 1000) })).toBe(false);
    expect(await holdsWith({ acceptedAt: "not a date" })).toBe(false);
    expect(await holdsWith({ role: "member" })).toBe(true);
    await saveUser({ ...(await getUser(owner.email))!, suspended: true });
    expect(await feedHolds(rec)).toBe(false);
  });

  it("rule 539: a link made before the login's current life began is refused (re-invited member, re-registered owner); a fresh one and an unparsable date are not", async () => {
    const later = () => new Promise((r) => setTimeout(r, 5));
    const ip = nextIp();
    // A member removed without a revoke (as if it failed) and invited again at the same address.
    const owner = await newUser("feed539r");
    const { email } = await newMember(owner, "member");
    const old = (await createFeed(email, owner.email, "en")) as string;
    expect((await callFeed(old, ip)).status).toBe(200);
    await Promise.all([db.del(`member:${email}`), db.srem(`members:${owner.email}`, email)]);
    await later();
    await createMember(owner.email, { email, name: "Again", password: "abc12345", lang: "ar", role: "member", invitedBy: owner.email });
    const found = await resolveFeed(old);
    expect(found).not.toBeNull();
    expect(Date.parse(found!.rec.createdAt)).toBeLessThan(Date.parse((await getMember(email))!.acceptedAt));
    expect(await feedHolds(found!.rec)).toBe(false);
    const stale = await callFeed(old, ip);
    expect(stale.status).toBe(404);
    expect(await stale.text()).toBe("");
    const fresh = (await createFeed(email, owner.email, "en")) as string;
    expect((await callFeed(fresh, ip)).status).toBe(200);
    // The same record with a date that cannot be read is not refused for that reason.
    expect(await feedHolds({ ...(await resolveFeed(fresh))!.rec, createdAt: "not a date" })).toBe(true);

    // An owner deleted without a revoke and registered again at the same address.
    const o2 = await newUser("feed539o");
    const oldOwner = (await createFeed(o2.email, o2.email, "en")) as string;
    expect((await callFeed(oldOwner, ip)).status).toBe(200);
    await db.del(`user:${o2.email}`);
    await later();
    await markVerified((await createUser({ email: o2.email, name: "Again", phone: "", password: "abc12345", lang: "ar" })).email);
    expect((await callFeed(oldOwner, ip)).status).toBe(404);
    const freshOwner = (await createFeed(o2.email, o2.email, "en")) as string;
    expect((await callFeed(freshOwner, ip)).status).toBe(200);
    expect(await feedHolds({ ...(await resolveFeed(freshOwner))!.rec, createdAt: "not a date" })).toBe(true);
  });

  it("rule 577: tenant isolation, the feed reads only the record's scope", async () => {
    const due = iso(Date.now() + DAY);
    const a = await newUser("feed577");
    const b = await newUser("feed577b");
    await saveBrands(a.email, brandRows("active"));
    const inDefault = await seed(a.email, { dueAt: due });
    const inTwo = await seed(`${a.email}#b2`, { dueAt: due });
    const inOther = await seed(b.email, { dueAt: due });
    const uid = (it: SecItem) => `UID:${it.id}@thakeen`;

    const brandTwo = await (await callFeed(await createFeed(a.email, `${a.email}#b2`, "en"))).text();
    expect(brandTwo).toContain(uid(inTwo));
    for (const x of [inDefault, inOther]) expect(brandTwo).not.toContain(uid(x));

    const member = await newMember(a, "member");
    const ownAddress = await seed(member.email, { dueAt: due });
    const memberFeed = await (await callFeed(await createFeed(member.email, a.email, "en"))).text();
    expect(memberFeed).toContain(uid(inDefault));
    for (const x of [inTwo, inOther, ownAddress]) expect(memberFeed).not.toContain(uid(x));

    // A record whose scope is not one of its login's own active brands is refused, whatever it names.
    const refused = [
      [member.email, member.email],
      [member.email, b.email],
      [a.email, b.email],
      [a.email, `${a.email}#nope`],
      [a.email, `${a.email}#default`],
      [a.email, `${a.email}x`],
      [a.email, a.email.toUpperCase()],
    ];
    for (const [login, scope] of refused) {
      const r = await callFeed(await createFeed(login, scope, "en"));
      expect(r.status, `${login} -> ${scope}`).toBe(404);
      expect(await r.text()).toBe("");
    }
  });

  it("rule 578: rate limits answer 429 with Retry-After before any item read", async () => {
    const o = await newUser("feed578");
    await seed(o.email, { dueAt: iso(Date.now() + DAY) });
    const token = await createFeed(o.email, o.email, "en");
    const refusedWithoutRead = async (ip: string) => {
      const list = vi.spyOn(secretary, "listOpenItems");
      try {
        const r = await callFeed(token, ip);
        expect(r.status).toBe(429);
        expect(r.headers.get("retry-after")).toBe("3600");
        expect(await r.text()).toBe("");
        expect(list).not.toHaveBeenCalled();
      } finally {
        list.mockRestore();
      }
    };

    // 120 calls from one address pass its bucket (unknown links, so the link's own bucket is untouched); the 121st is refused.
    const ip = nextIp();
    for (let i = 0; i < 120; i++) expect((await callFeed(randomBytes(32).toString("base64url"), ip)).status).toBe(404);
    await refusedWithoutRead(ip);

    // 60 calls for one link from 60 addresses pass; the 61st is refused, from a fresh address too.
    for (let i = 0; i < 60; i++) expect((await callFeed(token)).status).toBe(200);
    await refusedWithoutRead(nextIp());
  });

  it("rule 579: headers", async () => {
    const o = await newUser("feed579");
    const it = await seed(o.email, { dueAt: iso(Date.now() + DAY) });
    const token = await createFeed(o.email, o.email, "ar");
    const r = await callFeed(token);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("private, max-age=300");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.headers.get("set-cookie")).toBeNull();
    const body = await r.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain(`UID:${it.id}@thakeen\r\n`);
    expect(unfold(body)).toContain("X-WR-CALNAME:ذكين: مهامي\r\n");
    // The link inside is the app's own origin, never the request's host.
    expect(unfold(body)).toContain(`URL:${appOrigin()}/ar/app/todo\r\n`);
    expect(body).not.toContain("http://x/");

    const ics = await callFeed(`${token}.ics`);
    expect(ics.status).toBe(200);
    expect(await ics.text()).toBe(body);
    expect((await callFeed(`${token}.ics.ics`)).status).toBe(404);
  });
});

describe("feed management (rules 580-581)", () => {
  const FEED = "/api/secretary/feed";
  const status = () => manageRoute.GET();
  const create = (body?: unknown, raw?: string) =>
    manageRoute.POST(raw === undefined ? json(FEED, "POST", body) : new Request(`https://nashr.test${FEED}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw }));
  const stop = () => manageRoute.DELETE();
  const tokenOf = (url: string) => url.replace(/^.*\/feed\//, "").replace(/\.ics$/, "");

  it("rule 580: anonymous 401; owner, admin and member 200; a founder impersonating gets 403 on POST and DELETE; GET never returns the link", async () => {
    signOut();
    for (const r of [await status(), await create({}), await stop()]) {
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ ok: false, error: "unauthorized" });
    }

    const owner = await newUser("feed580");
    const admin = await newMember(owner, "admin");
    const member = await newMember(owner, "member");
    for (const login of [owner.email, admin.email, member.email]) {
      await signIn(login);
      const made = await create({ lang: "en" });
      expect(made.status).toBe(200);
      expect(made.headers.get("cache-control")).toBe("no-store");
      const b = await made.json();
      expect(b.ok).toBe(true);
      expect(b.url).toBe(`${appOrigin()}/api/secretary/feed/${tokenOf(b.url)}.ics`);
      expect(tokenOf(b.url)).toMatch(FEED_TOKEN);
      expect(b.webcal).toBe(b.url.replace(/^https?:/, "webcal:"));
      expect(b.webcal.startsWith("webcal://")).toBe(true);
      // The record is the acting login's own, in the account's scope, never another login's.
      const recs = recordsOf(login);
      expect(recs).toHaveLength(1);
      expect(recs[0][1]).toMatchObject({ login, scope: owner.email, lang: "en" });
      expect(hashFeedToken(tokenOf(b.url))).toBe(await db.get(FEED_KEYS.of(login)));

      const st = await status();
      expect(st.status).toBe(200);
      expect(st.headers.get("cache-control")).toBe("no-store");
      const text = await st.text();
      expect(JSON.parse(text)).toEqual({ ok: true, exists: true, createdAt: recs[0][1] && (recs[0][1] as { createdAt: string }).createdAt, sameBrand: true });
      expect(text).not.toContain(tokenOf(b.url));
      expect(text).not.toContain("webcal");
      expect(text).not.toContain("http");
      expect(text).not.toContain(hashFeedToken(tokenOf(b.url)));
    }
    // The three logins have three separate links: stopping one leaves the others.
    await signIn(member.email);
    const stopped = await stop();
    expect(stopped.status).toBe(200);
    expect(stopped.headers.get("cache-control")).toBe("no-store");
    expect(await getFeedStatus(member.email)).toEqual({ exists: false, createdAt: null });
    expect((await getFeedStatus(owner.email)).exists).toBe(true);
    expect((await getFeedStatus(admin.email)).exists).toBe(true);

    // A founder impersonating the account: status is readable, but nothing that outlives the session may be made or stopped.
    await signIn(owner.email, { imp: FOUNDER });
    const before = recordsOf(owner.email);
    const p = await create({});
    expect(p.status).toBe(403);
    expect(await p.json()).toEqual({ error: "forbidden" });
    expect((await stop()).status).toBe(403);
    expect(recordsOf(owner.email)).toEqual(before);
    const g = await status();
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ ok: true, exists: true });
  });

  it("rule 580: with no valid lang in the body the link takes the acting login's own language, a valid lang wins", async () => {
    const langOf = (login: string) => (recordsOf(login)[0][1] as { lang: string }).lang;
    for (const [ownerLang, memberLang] of [["en", "ar"], ["ar", "en"]] as const) {
      const owner = await newUser(`feed580l${ownerLang}`);
      // The owner's language is the owner PERSON's (multi-workspace M1, rule 2132), mirrored to the account.
      await updatePerson(ownerOf(owner), { lang: ownerLang });
      const member = await newMember(owner, "member");
      // A member's language is its person's too since multi-workspace M1 (the accept writes the `person:` row).
      await updatePerson(storedPersonId(member.email), { lang: memberLang });
      await signIn(member.email);
      expect((await create({})).status).toBe(200);
      expect(langOf(member.email)).toBe(memberLang);
      expect((await create({ lang: "fr" })).status).toBe(200);
      expect(langOf(member.email)).toBe(memberLang);
      expect((await create({ lang: ownerLang })).status).toBe(200);
      expect(langOf(member.email)).toBe(ownerLang);
      await signIn(owner.email);
      expect((await create({})).status).toBe(200);
      expect(langOf(owner.email)).toBe(ownerLang);
    }
  });

  it("rule 580: a body cannot choose the login, scope or language outside ar and en, and a bad body never gives a 500", async () => {
    const owner = await newUser("feed580b");
    const other = await newUser("feed580c");
    await signIn(owner.email);
    const evil = await create({ login: other.email, email: other.email, scope: other.email, lang: "fr" });
    expect(evil.status).toBe(200);
    expect(recordsOf(other.email)).toEqual([]);
    expect(recordsOf(owner.email)[0][1]).toMatchObject({ login: owner.email, scope: owner.email, lang: owner.lang });
    for (const raw of ["", "{", "null", "[]", '"x"', "7"]) expect((await create(undefined, raw)).status).toBe(200);
    expect(recordsOf(owner.email)).toHaveLength(1);
  });

  it("rule 581: the status says whether the link was made in the brand shown now (sameBrand), and never the scope", async () => {
    const owner = await newUser("feed581b");
    await saveBrands(owner.email, [
      { id: "default", name: "", createdAt: iso(NOW), status: "active" },
      { id: "b2", name: "Two", createdAt: iso(NOW), status: "active" },
    ]);
    await signIn(owner.email);
    const none = await (await status()).json();
    expect(none).toEqual({ ok: true, exists: false, createdAt: null, sameBrand: true });
    expect((await create({ lang: "en" })).status).toBe(200);
    const same = await (await status()).json();
    expect(same).toMatchObject({ ok: true, exists: true, sameBrand: true });
    // The active brand moves to another one of the account's brands: the link is still the old brand's.
    await db.set(`activebrand:${owner.email}`, "b2");
    const text = await (await status()).text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, exists: true, sameBrand: false });
    expect(text).not.toContain("b2");
    expect(text).not.toContain(owner.email);
    // Renewing moves it to the brand now shown.
    expect((await create({ lang: "en" })).status).toBe(200);
    expect(await (await status()).json()).toMatchObject({ exists: true, sameBrand: true });
  });

  it("rule 581: create, status, stop; stop twice is 200; the stopped link gives 404 on the public route; a second create replaces the first", async () => {
    const owner = await newUser("feed581");
    await signIn(owner.email);
    expect(await (await status()).json()).toEqual({ ok: true, exists: false, createdAt: null, sameBrand: true });
    const first = tokenOf((await (await create({})).json()).url);
    expect((await callFeed(first)).status).toBe(200);
    const second = tokenOf((await (await create({ lang: "en" })).json()).url);
    expect(second).not.toBe(first);
    expect((await callFeed(first)).status).toBe(404);
    expect((await callFeed(second)).status).toBe(200);
    expect(recordsOf(owner.email)).toHaveLength(1);
    expect((await (await status()).json()).exists).toBe(true);

    for (let i = 0; i < 2; i++) {
      const r = await stop();
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    expect((await callFeed(second)).status).toBe(404);
    expect(await (await status()).json()).toEqual({ ok: true, exists: false, createdAt: null, sameBrand: true });
    expect(recordsOf(owner.email)).toEqual([]);
  });

  it("rule 581: a lock held by another create answers 409 busy; the 21st write in an hour is 429 and writes nothing, and the status read has its own bucket", async () => {
    const owner = await newUser("feed581b");
    await signIn(owner.email);
    const owned = await db.lockOwned(`lock:feed:${owner.email}`, 10);
    expect(owned).toBeTruthy();
    const busy = await create({});
    expect(busy.status).toBe(409);
    expect(busy.headers.get("cache-control")).toBe("no-store");
    expect(await busy.json()).toEqual({ ok: false, error: "busy" });
    await db.unlockOwned(`lock:feed:${owner.email}`, owned!);
    expect(recordsOf(owner.email)).toEqual([]);

    // That busy answer was write 1; POST and DELETE share one bucket per login (`sec:feed:{login}`, 20 an hour).
    // Status reads in between use their own bucket and do not count against it.
    const writes = [() => create({}), stop];
    for (let i = 1; i < 20; i++) {
      expect((await writes[i % 2]()).status).toBe(200);
      expect((await status()).status).toBe(200);
    }
    for (const r of [await create({}), await stop()]) {
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ ok: false, error: "too_many" });
    }
    // The manage bucket is spent, and the status read still answers: 25 calls, all 200 (no refusal from the shared bucket).
    for (let i = 0; i < 25; i++) expect((await status()).status).toBe(200);
    // Another login has its own bucket.
    const mate = await newUser("feed581c");
    await signIn(mate.email);
    expect((await status()).status).toBe(200);
  });
});

describe("feed revocation (rules 582-583)", () => {
  const live = async (login: string, scope: string) => {
    const token = await createFeed(login, scope, "en");
    expect(token).not.toBe("busy");
    expect(FEED_TOKEN.test(token as string)).toBe(true);
    // A link that answers 200 now, so the 404 later means the revoke and not a link that never worked.
    expect((await callFeed(token as string)).status).toBe(200);
    return token as string;
  };
  /** Dead in every way: the public route, the status, the record and the pointer. */
  const expectEnded = async (login: string, token: string) => {
    expect((await callFeed(token)).status, `public route for ${login}`).toBe(404);
    expect(await getFeedStatus(login)).toEqual({ exists: false, createdAt: null });
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(token)))).toBeNull();
    expect(await db.get(FEED_KEYS.of(login))).toBeNull();
  };
  const expectAlive = async (login: string, token: string) => {
    expect((await callFeed(token)).status, `public route for ${login}`).toBe(200);
    expect((await getFeedStatus(login)).exists).toBe(true);
  };
  let ipN2 = 0;
  const ipH = () => ({ "x-forwarded-for": `198.18.7.${++ipN2}` });
  /** A real reset link for this login (what /api/auth/forgot stores), redeemed through the real route. */
  const resetAs = async (email: string, kind: "owner" | "member", password: string) => {
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email, kind });
    return resetRoute.POST(json("/api/auth/reset", "POST", { token, password }, ipH()));
  };

  it("rule 582: removing a member, resetting a password and changing a password end that login's feed, and only that login's", async () => {
    const owner = await newUser("feed582");
    const [m1, m2, m3, m4, m5, m6] = [await newMember(owner, "member"), await newMember(owner, "member"), await newMember(owner, "admin"), await newMember(owner, "member"), await newMember(owner, "member"), await newMember(owner, "admin")];
    const other = await newUser("feed582x");
    const t = {
      owner: await live(owner.email, owner.email),
      m1: await live(m1.email, owner.email),
      m2: await live(m2.email, owner.email),
      m3: await live(m3.email, owner.email),
      m4: await live(m4.email, owner.email),
      m5: await live(m5.email, owner.email),
      m6: await live(m6.email, owner.email),
    };
    const bystander = await live(other.email, other.email);

    // 1. Removed by the owner (removeMember): that member's feed ends, everyone else's stays.
    const acting = (await resolveAs(owner.email))!;
    expect(await removeMember(acting, acting.actor!, m1.email)).toEqual({ ok: true });
    await expectEnded(m1.email, t.m1);
    await expectAlive(owner.email, t.owner);
    await expectAlive(m2.email, t.m2);

    // 2. Removed by the founder console (forceRemoveMember, the same drop).
    expect(await forceRemoveMember(m2.email)).toBe(true);
    await expectEnded(m2.email, t.m2);
    await expectAlive(owner.email, t.owner);

    // 3. A member's own password reset ends that member's feed, not the owner's.
    expect((await resetAs(m3.email, "member", "reset12345")).status).toBe(200);
    await expectEnded(m3.email, t.m3);
    await expectAlive(owner.email, t.owner);
    await expectAlive(m4.email, t.m4);

    // 4. A member's own password change ends that member's feed, not the owner's.
    await signIn(m4.email);
    expect((await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: m4.password, newPassword: "fresh12345" }))).status).toBe(200);
    await expectEnded(m4.email, t.m4);
    await expectAlive(owner.email, t.owner);

    // 5. The owner's password reset by the link ends the owner's link and every member's, as it ends every member's session.
    expect((await resetAs(owner.email, "owner", "owner12345")).status).toBe(200);
    await expectEnded(owner.email, t.owner);
    await expectEnded(m5.email, t.m5);
    await expectEnded(m6.email, t.m6);
    await expectAlive(other.email, bystander);

    // 6. The founder's reset of the owner: the same, for the owner and the members that have a link again.
    t.owner = await live(owner.email, owner.email);
    t.m5 = await live(m5.email, owner.email);
    // The founder is a real account signed in as themselves (as in teams-core.test.ts).
    if (!(await getUser(FOUNDER))) await markVerified((await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" })).email);
    await signIn(FOUNDER);
    const res = await adminUserRoute.POST(json("/api/admin/users/x", "POST", { action: "resetPassword" }), params({ email: encodeURIComponent(owner.email) }));
    expect(res.status).toBe(200);
    const { tempPassword } = (await res.json()) as { tempPassword: string };
    await expectEnded(owner.email, t.owner);
    await expectEnded(m5.email, t.m5);
    await expectAlive(other.email, bystander);

    // 7. The owner's own password change ends the owner's link only: the members keep their sessions, so their links stay.
    t.owner = await live(owner.email, owner.email);
    t.m5 = await live(m5.email, owner.email);
    await signIn(owner.email);
    expect((await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: tempPassword, newPassword: "changed12345" }))).status).toBe(200);
    await expectEnded(owner.email, t.owner);
    await expectAlive(m5.email, t.m5);
    await expectAlive(other.email, bystander);
  });

  it("rule 582: a password event ends the old links at read time even when the revoke fails, and a link made after it works", async () => {
    const owner = await newUser("feed582s");
    const m1 = await newMember(owner, "member");
    const m2 = await newMember(owner, "member");
    const wait = () => new Promise((r) => setTimeout(r, 15));
    // Every revoke fails (the lock throws), after the password and the stamps are saved: the route throws, as it would on a store error.
    const failing = async (run: () => Promise<unknown>) => {
      const lock = vi.spyOn(db, "lockOwned").mockRejectedValue(new Error("store down"));
      try { await expect(run()).rejects.toThrow("store down"); } finally { lock.mockRestore(); }
    };

    // 1. A member's own reset: that member's old link is dead, the owner's and the other member's are not.
    let t = { owner: await live(owner.email, owner.email), m1: await live(m1.email, owner.email), m2: await live(m2.email, owner.email) };
    await wait();
    await failing(() => resetAs(m1.email, "member", "reset12345"));
    expect(await getFeedStatus(m1.email)).toMatchObject({ exists: true });
    expect((await callFeed(t.m1)).status).toBe(404);
    expect((await callFeed(t.owner)).status).toBe(200);
    expect((await callFeed(t.m2)).status).toBe(200);
    // A link made after the stamp works.
    t.m1 = await live(m1.email, owner.email);
    await wait();

    // 2. A member's own password change: the same.
    await signIn(m2.email);
    await failing(() => accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: m2.password, newPassword: "fresh12345" })));
    expect((await callFeed(t.m2)).status).toBe(404);
    expect((await callFeed(t.owner)).status).toBe(200);
    expect((await callFeed(t.m1)).status).toBe(200);
    t.m2 = await live(m2.email, owner.email);
    await wait();

    // 3. The owner's password change stamps only the owner: the owner's old link is dead, the members' stay.
    await signIn(owner.email);
    await failing(() => accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: "changed12345" })));
    expect((await callFeed(t.owner)).status).toBe(404);
    expect((await callFeed(t.m1)).status).toBe(200);
    expect((await callFeed(t.m2)).status).toBe(200);
    t.owner = await live(owner.email, owner.email);
    await wait();

    // 4. The owner's reset stamps the whole team: every old link is dead, new ones made after it work.
    await failing(() => resetAs(owner.email, "owner", "owner12345"));
    for (const k of ["owner", "m1", "m2"] as const) expect((await callFeed(t[k])).status, k).toBe(404);
    t = { owner: await live(owner.email, owner.email), m1: await live(m1.email, owner.email), m2: await live(m2.email, owner.email) };
    await wait();

    // 5. The founder's reset of the owner: the same.
    if (!(await getUser(FOUNDER))) await markVerified((await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" })).email);
    await signIn(FOUNDER);
    await failing(() => adminUserRoute.POST(json("/api/admin/users/x", "POST", { action: "resetPassword" }), params({ email: encodeURIComponent(owner.email) })));
    for (const k of ["owner", "m1", "m2"] as const) expect((await callFeed(t[k])).status, k).toBe(404);
    await live(owner.email, owner.email);
    await live(m1.email, owner.email);
  });

  it("rule 582: a member who leaves the team loses the link", async () => {
    const owner = await newUser("feed582l");
    const m = await newMember(owner, "member");
    const stay = await newMember(owner, "member");
    const mine = await live(m.email, owner.email);
    const theirs = await live(stay.email, owner.email);
    const u = await resolveAs(m.email);
    expect(await leaveTeam(u!)).toEqual({ ok: true });
    await expectEnded(m.email, mine);
    await expectAlive(stay.email, theirs);
  });

  it("rule 583: deleting the account leaves no sec:feed or sec:feedof key for the owner or any member", async () => {
    const owner = await newUser("feed583");
    const bystander = await newUser("feed583b");
    const m1 = await newMember(owner, "member");
    const m2 = await newMember(owner, "admin");
    const logins = [owner.email, m1.email, m2.email];
    const tokens = { [owner.email]: await live(owner.email, owner.email), [m1.email]: await live(m1.email, owner.email), [m2.email]: await live(m2.email, owner.email) };
    const keep = await live(bystander.email, bystander.email);
    const hashes = Object.values(tokens).map(hashFeedToken);
    expect(memKeys().filter((k) => logins.some((l) => k === FEED_KEYS.of(l)))).toHaveLength(3);

    await wipeAccount(owner.email);

    const leftKeys = memKeys().filter((k) => logins.some((l) => k === FEED_KEYS.of(l)) || hashes.some((h) => k === FEED_KEYS.rec(h)));
    expect(leftKeys).toEqual([]);
    expect(logins.flatMap(recordsOf)).toEqual([]);
    // No key of the feed family still ends with one of these logins, and no stored value names a hash of these links.
    expect(memKeys().filter((k) => k.startsWith("sec:feed") && logins.some((l) => k.endsWith(`:${l}`)))).toEqual([]);
    expect(memValues().filter((v) => hashes.some((h) => v.includes(h)))).toEqual([]);
    for (const l of logins) expect((await callFeed(tokens[l])).status).toBe(404);
    // Another account's link is not touched.
    await expectAlive(bystander.email, keep);
  });

  it("rule 583: a revoke that fails stops the wipe before the account is touched, and a second wipe finishes it", async () => {
    const owner = await newUser("feed583f");
    const m = await newMember(owner, "member");
    const tokens = [await live(owner.email, owner.email), await live(m.email, owner.email)];
    const lock = vi.spyOn(db, "lockOwned").mockRejectedValueOnce(new Error("store down"));
    try {
      await expect(wipeAccount(owner.email)).rejects.toThrow("store down");
    } finally {
      lock.mockRestore();
    }
    // The first step failed: nothing of the account was deleted yet, so the owner can still see and retry.
    expect(await getUser(owner.email)).not.toBeNull();
    expect(await getMember(m.email)).not.toBeNull();
    await wipeAccount(owner.email);
    expect(await getUser(owner.email)).toBeNull();
    expect(await getMember(m.email)).toBeNull();
    for (const t of tokens) expect((await callFeed(t)).status).toBe(404);
    expect(memKeys().filter((k) => [owner.email, m.email].some((l) => k === FEED_KEYS.of(l)))).toEqual([]);
  });
});

describe("feed card (rules 584-585)", () => {
  const LANGS = ["ar", "en"] as const;
  it("rule 584: both languages carry every feed string, Latin digits, no number of ours", () => {
    const ar = appDict.ar.todo.feed as Record<string, string>;
    const en = appDict.en.todo.feed as Record<string, string>;
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    // The strings the card and the file need, named in the brief: none may go missing.
    for (const k of ["title", "create", "renew", "stop", "copy", "copied", "since", "otherBrand", "warning", "iphone", "google", "outlook", "busy", "error", "mine", "waiting"]) {
      expect(ar[k], `ar.${k}`).toBeTruthy();
      expect(en[k], `en.${k}`).toBeTruthy();
    }
    for (const [lang, d] of [["ar", ar], ["en", en]] as const) {
      for (const [k, v] of Object.entries(d)) {
        expect(v.trim(), `${lang}.${k}`).not.toBe("");
        // No Arabic-Indic or Persian digit: Latin digits only.
        expect(v, `${lang}.${k}`).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/);
        // No price, credit or message allowance of ours, and no digit at all beyond what a product name carries.
        expect(v, `${lang}.${k}`).not.toMatch(/\d/);
        for (const n of [...SELF_SERVE_PLANS.flatMap((p) => [PLAN_PRICE_SAR[p], PLAN_CREDITS[p], CHAT_ALLOWANCE[p]])]) {
          expect(v, `${lang}.${k}`).not.toMatch(new RegExp(`\\b(${n}|${formatCount(n).replace(",", "\\,")})\\b`));
        }
      }
    }
    // The two who-acts phrases feed the file: the English and Arabic words stay what the calendar has always said.
    expect(ar.mine).toBe("عليّ أنا");
    expect(ar.waiting).toBe("ننتظر {name}");
    expect(en.mine).toBe("Mine");
    expect(en.waiting).toBe("Waiting on {name}");
    // Google's line says it refuses webcal://; the webcal:// text is only ever a link's scheme, never a promise.
    expect(ar.google).toContain("webcal://");
    expect(en.google).toContain("webcal://");
  });

  /** The text as `renderToStaticMarkup` writes it. */
  const html = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const URL_ = "https://thakeen.example/api/secretary/feed/" + "a".repeat(43) + ".ics";
  const WEBCAL = URL_.replace(/^https:/, "webcal:");
  const view = (lang: "ar" | "en", state: FeedState, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(FeedView, { t: appDict[lang], state, ...extra }));

  it("rule 585: the card shows the link once", () => {
    for (const lang of LANGS) {
      const T = appDict[lang].todo.feed;
      // Created: the https link and the webcal:// version, a Copy button for each, the warning and the three apps.
      const created = view(lang, { kind: "created", url: URL_, webcal: WEBCAL });
      expect(created, lang).toContain(URL_);
      expect(created, lang).toContain(WEBCAL);
      // One visible Copy button per link, each named for what it copies.
      expect(created.split(`>${T.copy}</button>`).length - 1, lang).toBe(2);
      expect(created, lang).toContain(`aria-label="${T.copy}: ${T.link}"`);
      expect(created, lang).toContain(`aria-label="${T.copy}: ${html(T.webcal)}"`);
      for (const k of ["warning", "iphone", "google", "outlook", "shownOnce", "renew", "stop"] as const) expect(created, `${lang}.${k}`).toContain(html(T[k]));
      expect(created, lang).not.toContain(T.create);
      // Exists (the page was left and came back): the date, Renew and Stop, and no link.
      const since = formatWhen("2026-10-05T09:30:00.000Z", true, lang, Date.parse("2026-10-06T00:00:00.000Z"));
      const exists = view(lang, { kind: "exists", since });
      expect(since, lang).toMatch(/5/);
      expect(exists, lang).toContain(T.since.replace("{date}", since));
      expect(exists, lang).toContain(T.renew);
      expect(exists, lang).toContain(T.stop);
      expect(exists, lang).not.toContain("/api/secretary/feed/");
      expect(exists, lang).not.toContain("webcal:");
      expect(exists, lang).not.toContain(T.warning);
      // The line about another brand shows only when the link was made in a different brand (rule 585).
      expect(exists, lang).not.toContain(html(T.otherBrand));
      expect(view(lang, { kind: "exists", since, sameBrand: true }), lang).not.toContain(html(T.otherBrand));
      expect(view(lang, { kind: "exists", since, sameBrand: false }), lang).toContain(html(T.otherBrand));
      expect(view(lang, { kind: "created", url: URL_, webcal: WEBCAL }), lang).not.toContain(html(T.otherBrand));
      // None: one button; no link, no date. Loading and a failed read show neither the link nor a button.
      const none = view(lang, { kind: "none" });
      expect(none, lang).toContain(T.create);
      expect(none, lang).not.toContain("/api/secretary/feed/");
      for (const state of [{ kind: "loading" }, { kind: "failed" }] as FeedState[]) expect(view(lang, state), lang).not.toContain(T.create);
      // A failed read offers "Try again" (the handoff card's word) and says why in its own words when it has them.
      const failed = view(lang, { kind: "failed", text: "REFUSED" });
      expect(failed, lang).toContain("REFUSED");
      expect(failed, lang).toContain(`>${appDict[lang].handoff.retry}</button>`);
      expect(view(lang, { kind: "failed" }), lang).toContain(T.error);
    }
    // Stop asks first, inline.
    const T = appDict.en.todo.feed;
    const asking = view("en", { kind: "exists", since: "5 October" }, { confirming: true });
    expect(asking).toContain(T.confirmStop);
    expect(asking).toContain(T.confirmYes);
    // A copied button says so, and only the pressed one.
    // (one visible label and one polite live-region announcement for the pressed button; none for the other).
    expect(view("en", { kind: "created", url: URL_, webcal: WEBCAL }, { copied: "url" }).split(T.copied).length - 1).toBe(2);
    expect(view("en", { kind: "created", url: URL_, webcal: WEBCAL }, { copied: "url" })).toContain('aria-live="polite"');
    expect(view("en", { kind: "created", url: URL_, webcal: WEBCAL }).split(T.copied).length - 1).toBe(0);
  });

  it("rule 585: the link lives in component state only, and the card sits on My to-dos below the Away panel", () => {
    // The two files the link passes through: the card and the shared write hook. Comments are dropped so a banned word in
    // prose does not trip it. `location.` stays in the list: neither file has a legitimate use of it (no redirect, no URL
    // read), so a hit is real; `window.name`, `sendBeacon` and `postMessage` would carry the link out of the page.
    const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const card = code("src/components/app/FeedCard.tsx");
    expect(card).toContain("useState");
    const BANNED = ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "console.", "history.", "router.push", "router.replace", "location.", "sendBeacon", "postMessage", "window.open", "window.name"];
    for (const f of ["src/components/app/FeedCard.tsx", "src/components/app/useOneWrite.ts"]) for (const banned of BANNED) expect(code(f), `${f}: ${banned}`).not.toContain(banned);
    // The Copied label's timeout is cleared when the card goes away.
    expect(card).toContain("clearTimeout");
    const panel = readFileSync("src/components/app/TodoPanel.tsx", "utf8");
    expect(panel.indexOf("<AwayPanel")).toBeGreaterThan(-1);
    expect(panel.indexOf("<FeedCard")).toBeGreaterThan(panel.indexOf("<AwayPanel"));
    expect(readFileSync("src/components/app/CalendarPanel.tsx", "utf8")).not.toContain("FeedCard");
  });
});
