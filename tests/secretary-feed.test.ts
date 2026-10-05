import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newMember, newUser, signIn } from "./helpers/session";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { can, MIN_ROLE } from "@/lib/roles";
import { SEC_KEYS } from "@/lib/secretary";
import type { SecItem } from "@/lib/secretary-agenda";
import { buildIcs, feedItems, icsFold } from "@/lib/secretary-feed";
import { createFeed, FEED_KEYS, FEED_TOKEN, getFeedStatus, hashFeedToken, resolveFeed, revokeFeed, revokeFeeds } from "@/lib/feed-token";

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
