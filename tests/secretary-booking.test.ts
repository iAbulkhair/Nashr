import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newMember, newUser, params, signIn } from "./helpers/session";
import { currentUser, getUser, saveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import * as rate from "@/lib/rate";
import * as bookingRoute from "@/app/api/secretary/booking/[token]/route";
import { can, MIN_ROLE } from "@/lib/roles";
import {
  BOOK_KEYS, BOOK_PROVIDERS, BOOK_TOKEN, bookingKey, createBook, getBookStatus, hashBookToken, resolveBook, revokeBook, revokeBooks,
} from "@/lib/booking-token";
import { applyBooking, parseCalcom, parseCalendly, verifyCalcomSignature, verifyCalendlySignature, type Parsed } from "@/lib/secretary-booking";
import { SEC_KEYS, changeItem, createItem, getItem, listOpenItems, removeBySystem, secretaryKeys } from "@/lib/secretary";
import { SEC_RESTORE_DAYS, type SecItem } from "@/lib/secretary-agenda";
import { wipeAccount } from "@/lib/account";
import type { BookRecord } from "@/lib/booking-token";
import type { User } from "@/lib/auth";

const fx = (name: string): Record<string, unknown> => JSON.parse(readFileSync(`tests/fixtures/${name}.json`, "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const hex = (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex");

describe("booking signatures and parsers (rules 586-588)", () => {
  const KEY = "k".repeat(64);
  const BODY = JSON.stringify(fx("booking-calcom-created"));

  it("rule 586: Cal.com signature verifies a body and fails a changed body, a wrong key, a missing header and a header of the wrong length", () => {
    const sig = hex(KEY, BODY);
    expect(verifyCalcomSignature(BODY, sig, KEY)).toBe(true);
    expect(verifyCalcomSignature(BODY, sig.toUpperCase(), KEY)).toBe(true);
    expect(verifyCalcomSignature(BODY + " ", sig, KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, sig, "j".repeat(64))).toBe(false);
    expect(verifyCalcomSignature(BODY, null, KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, undefined, KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, "", KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, sig.slice(0, 62), KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, sig + "0", KEY)).toBe(false);
    // an empty key never verifies, even against the HMAC made with an empty key
    expect(verifyCalcomSignature(BODY, hex("", BODY), "")).toBe(false);
  });

  it("rule 587: Calendly signature verifies; fails on a stale timestamp (301 s), a future one, a wrong v1, a missing t, and an altered body", () => {
    const now = 1_790_000_000_000;
    const t = Math.floor(now / 1000);
    const header = (ts: number, body = BODY, key = KEY) => `t=${ts},v1=${hex(key, `${ts}.${body}`)}`;
    expect(verifyCalendlySignature(BODY, header(t), KEY, now)).toBe(true);
    expect(verifyCalendlySignature(BODY, header(t - 300), KEY, now)).toBe(true);
    expect(verifyCalendlySignature(BODY, header(t + 300), KEY, now)).toBe(true);
    expect(verifyCalendlySignature(BODY, header(t - 301), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, header(t + 301), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, header(t, BODY, "j".repeat(64)), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, `t=${t},v1=${"0".repeat(64)}`, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, `v1=${hex(KEY, `${t}.${BODY}`)}`, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, `t=${t}`, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY + " ", header(t), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, null, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, "", KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, "t=abc,v1=zz", KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, header(t), "", now)).toBe(false);
    // the timestamp is signed: a fresh t with the signature of an old one fails
    expect(verifyCalendlySignature(BODY, `t=${t},v1=${hex(KEY, `${t - 400}.${BODY}`)}`, KEY, now)).toBe(false);
    // unknown parts are ignored, order does not matter, the v1 may come first
    expect(verifyCalendlySignature(BODY, `v0=abc, v1=${hex(KEY, `${t}.${BODY}`)} ,t=${t},x=1`, KEY, now)).toBe(true);
  });

  const IGNORE = { kind: "ignore", externalId: "", name: "", eventName: "", start: "", end: "" } as const;

  it("rule 588: parsers map each fixture to the expected Parsed; an unknown event is ignore; missing fields are ignore, never a throw; a Calendly cancel flagged as a reschedule is ignore; a Calendly create naming an old invitee carries oldExternalId; every string is bounded", () => {
    const calcom = {
      created: { kind: "create", externalId: "bk_uid_aaaaaaaaaaaaaaaa", name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" },
      cancelled: { kind: "cancel", externalId: "bk_uid_aaaaaaaaaaaaaaaa", name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" },
      rescheduled: { kind: "move", externalId: "bk_uid_bbbbbbbbbbbbbbbb", oldExternalId: "bk_uid_aaaaaaaaaaaaaaaa", name: "Omar Example", eventName: "Intro call", start: "2026-10-14T10:00:00.000Z", end: "2026-10-14T10:30:00.000Z" },
    } satisfies Record<string, Parsed>;
    expect(parseCalcom(fx("booking-calcom-created"))).toEqual(calcom.created);
    expect(parseCalcom(fx("booking-calcom-cancelled"))).toEqual(calcom.cancelled);
    expect(parseCalcom(fx("booking-calcom-rescheduled"))).toEqual(calcom.rescheduled);

    const I1 = "https://api.calendly.com/scheduled_events/EXAMPLEEVENT0001/invitees/EXAMPLEINVITEE01";
    const I2 = "https://api.calendly.com/scheduled_events/EXAMPLEEVENT0002/invitees/EXAMPLEINVITEE02";
    expect(parseCalendly(fx("booking-calendly-created"))).toEqual({ kind: "create", externalId: I1, name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" });
    expect(parseCalendly(fx("booking-calendly-canceled"))).toEqual({ kind: "cancel", externalId: I1, name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" });
    // the create that names the old invitee: the move, carrying the old id
    expect(parseCalendly(fx("booking-calendly-created-rescheduled"))).toEqual({ kind: "move", externalId: I2, oldExternalId: I1, name: "Omar Example", eventName: "Intro call", start: "2026-10-14T10:00:00.000Z", end: "2026-10-14T10:30:00.000Z" });
    // the cancel that comes with it says it is a reschedule: nothing to do, the create owns the move
    expect(parseCalendly(fx("booking-calendly-canceled-rescheduled"))).toEqual(IGNORE);

    // the neutral shape never carries an email, a phone, a note, a link or a reason
    for (const f of ["booking-calcom-created", "booking-calcom-cancelled", "booking-calcom-rescheduled"]) {
      expect(JSON.stringify(parseCalcom(fx(f)))).not.toMatch(/@|\+1000|Private|video|http|Sara/);
    }
    for (const f of ["booking-calendly-created", "booking-calendly-canceled", "booking-calendly-created-rescheduled"]) {
      expect(JSON.stringify(parseCalendly(fx(f)))).not.toMatch(/@|\+1000|Private|video|zoom|Sara/);
    }

    // unknown events and a wrong trigger are ignore, whatever else the body says
    const cc = fx("booking-calcom-created");
    expect(parseCalcom({ ...cc, triggerEvent: "MEETING_ENDED" })).toEqual(IGNORE);
    expect(parseCalcom({ ...cc, triggerEvent: "booking_created" })).toEqual(IGNORE);
    const cy = fx("booking-calendly-created");
    expect(parseCalendly({ ...cy, event: "invitee_no_show.created" })).toEqual(IGNORE);
    expect(parseCalendly({ ...cy, event: "routing_form_submission.created" })).toEqual(IGNORE);

    // missing or invalid fields are ignore and never throw, for any input
    const junk: unknown[] = [null, undefined, 0, 1, "", "x", true, [], [1], {}, { payload: null }, { payload: [] }, { payload: "x" }, { triggerEvent: 5 }, { event: {} }];
    for (const j of junk) {
      expect(() => parseCalcom(j)).not.toThrow();
      expect(() => parseCalendly(j)).not.toThrow();
      expect(parseCalcom(j)).toEqual(IGNORE);
      expect(parseCalendly(j)).toEqual(IGNORE);
    }
    const mutate = <T,>(base: unknown, fn: (o: any) => void): T => { const o = clone(base); fn(o); return o as T; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const calBad: Array<(o: any) => void> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      o => delete o.payload.uid, o => { o.payload.uid = 7; }, o => { o.payload.uid = ""; }, o => delete o.payload.startTime, o => delete o.payload.endTime,
      o => { o.payload.startTime = "not a date"; }, o => { o.payload.endTime = 12; }, o => { o.payload.endTime = o.payload.startTime; },
      o => delete o.payload.attendees, o => { o.payload.attendees = []; }, o => { o.payload.attendees = [null]; }, o => { o.payload.attendees = [{ email: "a@example.com" }]; },
      o => { o.payload.attendees = [{ name: "   " }]; },
    ];
    for (const fn of calBad) expect(parseCalcom(mutate(fx("booking-calcom-created"), fn))).toEqual(IGNORE);
    const cyBad: Array<(o: any) => void> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      o => delete o.payload.uri, o => { o.payload.uri = 5; }, o => delete o.payload.name, o => { o.payload.name = ""; }, o => delete o.payload.scheduled_event,
      o => { o.payload.scheduled_event = null; }, o => delete o.payload.scheduled_event.start_time, o => { o.payload.scheduled_event.end_time = "soon"; },
      o => { o.payload.scheduled_event.end_time = o.payload.scheduled_event.start_time; },
    ];
    for (const fn of cyBad) expect(parseCalendly(mutate(fx("booking-calendly-created"), fn))).toEqual(IGNORE);
    // a cancel needs only the id: the item is found through it
    expect(parseCalcom(mutate(fx("booking-calcom-cancelled"), o => { delete o.payload.attendees; delete o.payload.startTime; delete o.payload.endTime; }))).toMatchObject({ kind: "cancel", externalId: "bk_uid_aaaaaaaaaaaaaaaa" });
    expect(parseCalendly(mutate(fx("booking-calendly-canceled"), o => { delete o.payload.scheduled_event; delete o.payload.name; }))).toMatchObject({ kind: "cancel", externalId: I1 });
    expect(parseCalcom(mutate(fx("booking-calcom-cancelled"), o => delete o.payload.uid))).toEqual(IGNORE);
    // an old id that is not a string is no old id: the create stays a create
    expect(parseCalendly(mutate(fx("booking-calendly-created"), o => { o.payload.old_invitee = 5; }))).toMatchObject({ kind: "create" });
    expect(parseCalendly(mutate(fx("booking-calendly-created"), o => { o.payload.old_invitee = ""; })).oldExternalId).toBeUndefined();
    // a Cal.com reschedule without the previous uid still moves (the id is unknown, the caller creates)
    expect(parseCalcom(mutate(fx("booking-calcom-rescheduled"), o => delete o.payload.rescheduleUid))).toMatchObject({ kind: "move", externalId: "bk_uid_bbbbbbbbbbbbbbbb" });

    // every string is bounded, cleaned (controls and direction marks removed) and every instant is ISO UTC
    const long = "x".repeat(5000);
    const dirty = `‮Omar\u0000\n\t  ${"ا".repeat(300)}`;
    const big = parseCalcom(mutate(fx("booking-calcom-rescheduled"), o => {
      o.payload.uid = "a" + long; o.payload.rescheduleUid = "b" + long; o.payload.eventTitle = long; o.payload.attendees = [{ name: dirty }];
      o.payload.startTime = "2026-10-14T13:00:00+03:00"; o.payload.endTime = "2026-10-14T13:30:00+03:00";
    }));
    expect(big.kind).toBe("move");
    expect(big.externalId.length).toBeLessThanOrEqual(200);
    expect(big.oldExternalId!.length).toBeLessThanOrEqual(200);
    expect(big.eventName.length).toBeLessThanOrEqual(120);
    expect(big.name.length).toBeLessThanOrEqual(80);
    expect(big.name).toMatch(/^Omar ا+$/);
    expect(big.name).not.toMatch(/[‮\u0000\n\t]/);
    expect(big.start).toBe("2026-10-14T10:00:00.000Z");
    expect(big.end).toBe("2026-10-14T10:30:00.000Z");
    const bigCy = parseCalendly(mutate(fx("booking-calendly-created-rescheduled"), o => {
      o.payload.uri = "a" + long; o.payload.old_invitee = "b" + long; o.payload.name = dirty; o.payload.scheduled_event.name = long;
    }));
    expect(bigCy.kind).toBe("move");
    expect(bigCy.externalId.length).toBeLessThanOrEqual(200);
    expect(bigCy.oldExternalId!.length).toBeLessThanOrEqual(200);
    expect(bigCy.eventName.length).toBeLessThanOrEqual(120);
    expect(bigCy.name.length).toBeLessThanOrEqual(80);
    expect(bigCy.name).not.toMatch(/[‮\u0000\n\t]/);

    // an instant without Z or an offset would be read in the server's own zone: it is no instant, so the booking is ignore
    expect(parseCalcom(mutate(fx("booking-calcom-created"), o => { o.payload.startTime = "2026-10-12T09:00:00"; }))).toEqual(IGNORE);
    expect(parseCalendly(mutate(fx("booking-calendly-created"), o => { o.payload.scheduled_event.end_time = "2026-10-12T09:30"; }))).toEqual(IGNORE);
    expect(parseCalcom(mutate(fx("booking-calcom-created"), o => { o.payload.startTime = "2026-10-12T12:00:00+0300"; }))).toMatchObject({ kind: "create", start: "2026-10-12T09:00:00.000Z" });
  });
});

const FOUNDER = "founder-book@test.example";
type Mem = { kv: Map<string, unknown>; lists: Map<string, unknown>; sets: Map<string, unknown>; hashes?: Map<string, unknown>; zsets?: Map<string, unknown> };
const mem = () => (globalThis as unknown as { __nashrMem: Mem }).__nashrMem;
const memKeys = () => { const m = mem(); return [...m.kv.keys(), ...m.lists.keys(), ...m.sets.keys(), ...(m.hashes?.keys() ?? []), ...(m.zsets?.keys() ?? [])]; };
const memValues = () => {
  const m = mem();
  const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x instanceof Map ? [...x.entries()] : x));
  return [...m.kv.values(), ...m.lists.values(), ...m.sets.values(), ...(m.hashes?.values() ?? []), ...(m.zsets?.values() ?? [])].map(ser);
};
/** The `sec:book:*` records that belong to this login. */
const recordsOf = (login: string) => [...mem().kv.entries()].filter(([k, v]) => k.startsWith("sec:book:") && (v as { login?: string }).login === login);
const resolveAs = async (email: string, opts: { imp?: string } = {}) => { await signIn(email, opts); return currentUser(); };

describe("booking token (rule 589)", () => {
  beforeAll(() => {
    vi.stubEnv("ADMIN_EMAILS", FOUNDER);
    vi.stubEnv("WAITLIST_ADMIN_KEY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv("ADMIN_EMAILS", FOUNDER); vi.stubEnv("WAITLIST_ADMIN_KEY", ""); });

  it("rule 589: only the SHA-256 is stored and the plain token is returned once; renewing deletes the old record; bookof keeps one link per login per provider; a record not named by bookof does not resolve; the derived key is stable per hash, differs per hash and per CONNECT_SECRET, and is never stored; booking.manage is member level and blocked while impersonating", async () => {
    expect(BOOK_PROVIDERS).toEqual(["calcom", "calendly"]);
    const login = (await newUser("book")).email;

    // Only the hash is stored; the plain token is returned once and appears in no key or value.
    const token = await createBook(login, login, "calcom", "ar");
    expect(token).toMatch(BOOK_TOKEN);
    const hash = hashBookToken(token);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(await db.get(BOOK_KEYS.rec(hash))).toEqual({ login, scope: login, provider: "calcom", lang: "ar", createdAt: expect.any(String) });
    expect(await db.get(BOOK_KEYS.of(login, "calcom"))).toBe(hash);
    expect(memKeys().filter((k) => k.includes(token))).toEqual([]);
    expect(memValues().filter((v) => v.includes(token))).toEqual([]);
    expect(await resolveBook(token)).toEqual({ login, scope: login, provider: "calcom", lang: "ar", createdAt: expect.any(String) });

    // Wrong shape is refused before any read.
    const get = vi.spyOn(db, "get");
    for (const bad of ["", "short", token + "x", token.slice(1), token.replace(/.$/, "!"), null as unknown as string, 5 as unknown as string]) {
      expect(await resolveBook(bad)).toBeNull();
    }
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();

    // Renewing deletes the old record; one link per login per provider; the other provider is independent.
    const other = await createBook(login, login, "calendly", "en");
    expect(other).toMatch(BOOK_TOKEN);
    const renewed = await createBook(login, login, "calcom", "en");
    expect(renewed).toMatch(BOOK_TOKEN);
    expect(renewed).not.toBe(token);
    expect(await resolveBook(token)).toBeNull();
    expect(await db.get(BOOK_KEYS.rec(hash))).toBeNull();
    expect((await resolveBook(renewed))?.lang).toBe("en");
    expect((await resolveBook(other))?.provider).toBe("calendly");
    expect(recordsOf(login)).toHaveLength(2);

    // A record that bookof does not name is dead.
    const orphan = randomBytes(32).toString("base64url");
    await db.set(BOOK_KEYS.rec(hashBookToken(orphan)), { login, scope: login, provider: "calcom", lang: "ar", createdAt: new Date().toISOString() });
    expect(await resolveBook(orphan)).toBeNull();
    // The pointer names that hash for that provider only: calendly's pointer naming it does not make a calcom record live.
    await db.set(BOOK_KEYS.of(login, "calendly"), hashBookToken(orphan));
    expect(await resolveBook(orphan)).toBeNull();
    await db.set(BOOK_KEYS.of(login, "calendly"), hashBookToken(other));

    // Status: one row per live provider, no token, no hash, no scope.
    const status = await getBookStatus(login);
    expect(status.map((r) => r.provider).sort()).toEqual(["calcom", "calendly"]);
    expect(status.every((r) => r.sameBrand && typeof r.createdAt === "string")).toBe(true);
    expect(JSON.stringify(status)).not.toContain(hashBookToken(renewed));
    expect((await getBookStatus(login, "other-brand@test.example")).every((r) => !r.sameBrand)).toBe(true);
    expect(await getBookStatus((await newUser("book")).email)).toEqual([]);

    // The derived key.
    vi.stubEnv("CONNECT_SECRET", "s".repeat(40));
    const key = bookingKey(hash);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(createHmac("sha256", "s".repeat(40)).update("booking:v1:" + hash).digest("hex"));
    expect(bookingKey(hash)).toBe(key);
    expect(bookingKey(hashBookToken(renewed))).not.toBe(key);
    vi.stubEnv("CONNECT_SECRET", "t".repeat(40));
    expect(bookingKey(hash)).not.toBe(key);
    // Never stored: no key or value in the store holds it, for any live record.
    vi.stubEnv("CONNECT_SECRET", "s".repeat(40));
    const live = [hashBookToken(renewed), hashBookToken(other)].map((h) => bookingKey(h));
    for (const k of live) {
      expect(memKeys().filter((x) => x.includes(k))).toEqual([]);
      expect(memValues().filter((v) => v.includes(k))).toEqual([]);
    }
    // Production without CONNECT_SECRET throws; development falls back.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONNECT_SECRET", "");
    expect(() => bookingKey(hash)).toThrow(/CONNECT_SECRET/);
    vi.stubEnv("NODE_ENV", "test");
    expect(bookingKey(hash)).toMatch(/^[0-9a-f]{64}$/);

    // booking.manage is member level and blocked while a founder impersonates.
    expect(MIN_ROLE["booking.manage"]).toBe("member");
    const owner = await newUser("bookown");
    const admin = await newMember(owner, "admin");
    const member = await newMember(owner, "member");
    expect(can(await resolveAs(owner.email), "booking.manage")).toBe(true);
    expect(can(await resolveAs(admin.email), "booking.manage")).toBe(true);
    expect(can(await resolveAs(member.email), "booking.manage")).toBe(true);
    const founder = await resolveAs(owner.email, { imp: FOUNDER });
    expect(founder!.actor).toMatchObject({ kind: "founder" });
    expect(can(founder, "booking.manage")).toBe(false);
  });

  it("rule 589: two creates at once leave one working link; revoke removes every provider, is idempotent, and never waits out a held lock; revokeBooks covers every login", async () => {
    const a = (await newUser("book")).email;
    const b = (await newUser("book")).email;
    const out = await Promise.all([createBook(a, a, "calcom", "ar"), createBook(a, a, "calcom", "ar")]);
    const good = out.filter((x) => x !== "busy");
    expect(good.length).toBeGreaterThanOrEqual(1);
    expect((await Promise.all(good.map((t) => resolveBook(t)))).filter((r) => r !== null)).toHaveLength(1);
    expect(recordsOf(a)).toHaveLength(1);

    const ta = await createBook(a, a, "calendly", "ar");
    const tb = await createBook(b, b, "calcom", "en");
    const held = await db.lockOwned(`lock:book:${a}:calcom`, 10);
    expect(held).not.toBeNull();
    try {
      expect(await createBook(a, a, "calcom", "ar")).toBe("busy");
      await revokeBooks([a, b]);
      expect(await resolveBook(ta)).toBeNull();
      expect(await resolveBook(tb)).toBeNull();
      expect(recordsOf(a)).toEqual([]);
      expect(recordsOf(b)).toEqual([]);
    } finally {
      await db.unlockOwned(`lock:book:${a}:calcom`, held!);
    }
    await revokeBook(a);
    expect(memKeys().filter((k) => k.startsWith(`sec:bookof:${a}:`) || k.startsWith(`sec:bookof:${b}:`))).toEqual([]);

    // One provider only.
    const c = (await newUser("book")).email;
    const t1 = await createBook(c, c, "calcom", "ar");
    const t2 = await createBook(c, c, "calendly", "ar");
    await revokeBook(c, "calcom");
    expect(await resolveBook(t1)).toBeNull();
    expect(await resolveBook(t2)).not.toBeNull();
    await revokeBook(c);
    expect(await getBookStatus(c)).toEqual([]);
  });
});

describe("applying a booking (rules 590-593)", () => {
  const MIN = 60_000, HOUR = 3600_000, DAY = 864e5;
  const iso = (ms: number) => new Date(ms).toISOString();
  /** A whole minute this far from now: the item keeps minutes, so a round instant reads back the same. */
  const minuteFrom = (ms: number) => Math.ceil((Date.now() + ms) / MIN) * MIN;
  const newHash = () => randomBytes(32).toString("hex");
  const recOf = (u: User, o: Partial<BookRecord> = {}): BookRecord => ({ login: u.email, scope: u.email, provider: "calcom", lang: "en", createdAt: new Date().toISOString(), ...o });
  const booking = (o: Partial<Parsed> = {}, startMs = minuteFrom(2 * DAY)): Parsed => ({ kind: "create", externalId: `bk_${randomBytes(6).toString("hex")}`, name: "Omar Example", eventName: "Intro call", start: iso(startMs), end: iso(startMs + 30 * MIN), ...o });
  /** An owner whose brand keeps its list in Dubai (UTC+4), not the default Riyadh (UTC+3). */
  const dubaiOwner = async () => {
    const u = await newUser("bkapply");
    await db.set(`brand:${u.email}`, { timeZone: "Asia/Dubai" });
    return u;
  };
  const auditOf = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x) as { action: string; actor: string; via: string; id: string });
  const claimOf = (scope: string, provider: string, id: string) => db.get<string>(`sec:book:ext:${scope}:${provider}:${id}`);
  const shifted = <T,>(name: string, startMs: number, set: (o: any, s: string, e: string) => void): T => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const o = clone(fx(name));
    set(o, iso(startMs), iso(startMs + 30 * MIN));
    return o as T;
  };

  it("rule 590: create makes one item (kind task, i_owe, source booking, title in the link's language, timed in the brand zone, remindAt only when the end is in the future); a replay and five concurrent replays make one item", async () => {
    const u = await dubaiOwner();
    const rec = recOf(u);
    const hash = newHash();
    const startMs = minuteFrom(2 * DAY);
    const p = booking({}, startMs);
    expect(await applyBooking(rec, p, hash)).toBe("created");
    const [it] = await listOpenItems(u.email);
    expect(it).toMatchObject({
      kind: "task", direction: "i_owe", owedBy: "owner", owedTo: "Omar Example", source: "booking", title: "Meeting with Omar Example",
      allDay: false, dueAt: iso(startMs), remindAt: iso(startMs + 30 * MIN),
    });
    expect(it.description).toContain("Intro call");
    expect(it.description).toContain("Cal.com");
    // the claim names the item, lives 400 days, and the account's key list (the wipe) finds it
    expect(await claimOf(u.email, "calcom", p.externalId)).toBe(it.id);
    expect(await db.ttl(`sec:book:ext:${u.email}:calcom:${p.externalId}`)).toBeGreaterThan(399 * 86400);
    expect(await auditOf(u.email)).toContainEqual(expect.objectContaining({ action: "create", actor: "rule", via: "cron", id: it.id }));

    // a replay is a no-op: one item
    expect(await applyBooking(rec, p, hash)).toBe("noop");
    expect(await listOpenItems(u.email)).toHaveLength(1);
    // five deliveries of a new booking at once: one item
    const q = booking();
    const five = await Promise.all(Array.from({ length: 5 }, () => applyBooking(rec, q, hash)));
    expect(five.filter((r) => r === "created")).toHaveLength(1);
    expect(five.filter((r) => r === "noop")).toHaveLength(4);
    expect(await listOpenItems(u.email)).toHaveLength(2);

    // A run that died after taking the claim and before writing its item (here: the store failed at the item's lock).
    // The claim already names the id the item will get, so a quick retry finishes it there: never dropped, never twice.
    const r1 = booking();
    const lockSpy = vi.spyOn(db, "lock").mockRejectedValueOnce(new Error("store down"));
    try {
      expect(await applyBooking(rec, r1, hash)).toBe("busy");
    } finally {
      lockSpy.mockRestore();
    }
    const id1 = (await claimOf(u.email, "calcom", r1.externalId))!;
    expect(id1).toMatch(/^s[a-f0-9]{16}$/);
    expect(await getItem(u.email, id1)).toBeNull();
    expect(await applyBooking(rec, r1, hash)).toBe("created");
    expect(await getItem(u.email, id1)).toMatchObject({ source: "booking", title: "Meeting with Omar Example" });
    expect(await applyBooking(rec, r1, hash)).toBe("noop");
    // A run that died after writing the item and before its indexes: the retry finds the item at the claimed id, lists it
    // again, and makes no second one.
    const r2 = booking();
    const zaddSpy = vi.spyOn(db, "zadd").mockRejectedValueOnce(new Error("store down"));
    try {
      expect(await applyBooking(rec, r2, hash)).toBe("busy");
    } finally {
      zaddSpy.mockRestore();
    }
    const id2 = (await claimOf(u.email, "calcom", r2.externalId))!;
    expect(await getItem(u.email, id2)).not.toBeNull();
    expect((await listOpenItems(u.email)).map((x) => x.id)).not.toContain(id2);
    expect(await applyBooking(rec, r2, hash)).toBe("noop");
    expect((await listOpenItems(u.email)).filter((x) => x.id === id2)).toHaveLength(1);
    expect(await listOpenItems(u.email)).toHaveLength(4);
    expect(await db.smembers(SEC_KEYS.all(u.email))).toHaveLength(4);

    // Arabic link: Arabic title; a meeting that already ended (less than a day ago) has no reminder
    const pastStart = minuteFrom(-3 * HOUR);
    expect(await applyBooking(recOf(u, { lang: "ar" }), booking({ name: "عمر" }, pastStart), hash)).toBe("created");
    const ar = (await listOpenItems(u.email)).find((x) => x.title.startsWith("اجتماع"))!;
    expect(ar).toMatchObject({ title: "اجتماع مع عمر", dueAt: iso(pastStart), remindAt: null, source: "booking" });

    // A Calendly link's claims are its own provider's; account deletion removes every claim and the claim index
    const cy = booking({ externalId: "https://api.calendly.com/scheduled_events/E1/invitees/I1" });
    expect(await applyBooking(recOf(u, { provider: "calendly" }), cy, hash)).toBe("created");
    const keys = await secretaryKeys(u.email);
    for (const id of [p.externalId, q.externalId]) expect(keys).toContain(`sec:book:ext:${u.email}:calcom:${id}`);
    expect(keys).toContain(`sec:book:ext:${u.email}:calendly:${cy.externalId}`);
    await wipeAccount(u.email);
    const left = [...mem().kv.keys(), ...mem().sets.keys()].filter((k) => k.includes(u.email) && (k.startsWith("sec:book:ext:") || k.startsWith("sec:bookext:")));
    expect(left).toEqual([]);
  });

  it("rule 591: the item and its notes hold no email, phone, link or cancellation text from the payload; a hostile or empty name gives one clean title line; a booking more than a day in the past or more than 366 days ahead is noop", async () => {
    const u = await dubaiOwner();
    const hash = newHash();
    const startMs = minuteFrom(3 * DAY);
    const cc = parseCalcom(shifted(`booking-calcom-created`, startMs, (o, s, e) => { o.payload.startTime = s; o.payload.endTime = e; }));
    const cy = parseCalendly(shifted(`booking-calendly-created`, startMs + DAY, (o, s, e) => { o.payload.scheduled_event.start_time = s; o.payload.scheduled_event.end_time = e; }));
    expect(await applyBooking(recOf(u), cc, hash)).toBe("created");
    expect(await applyBooking(recOf(u, { provider: "calendly" }), cy, hash)).toBe("created");
    const items = await listOpenItems(u.email);
    expect(items).toHaveLength(2);
    const PII = /@|\+1000|Private|video|zoom|http|Sara|cancellations|example\.com/i;
    for (const it of items) {
      expect(JSON.stringify(it)).not.toMatch(PII);
      expect(it.notes).toEqual([]);
      expect(it.phone ?? null).toBeNull();
    }
    expect(JSON.stringify(await db.lrange(SEC_KEYS.audit(u.email), 0, -1))).not.toMatch(PII);

    // hostile names: one clean line, at most 200 characters; an empty name is "a guest" and names no one
    const titleOf = async (name: string, lang: "ar" | "en" = "en") => {
      const p = booking({ name });
      expect(await applyBooking(recOf(u, { lang }), p, hash)).toBe("created");
      return (await getItem(u.email, (await claimOf(u.email, "calcom", p.externalId))!))!;
    };
    for (const name of [`\r\nInjected\r\n${"x".repeat(10_000)}`, "‮Omar‬\u0000\tExample", "  \r\n  "]) {
      const it = await titleOf(name);
      expect(it.title.length).toBeLessThanOrEqual(200);
      expect(it.title).not.toMatch(/[\r\n\t\u0000‮‬]/);
      expect(it.title).toMatch(/^Meeting with \S/);
    }
    expect((await titleOf("‮Omar‬\u0000\tExample")).title).toBe("Meeting with Omar Example");
    expect(await titleOf("")).toMatchObject({ title: "Meeting with a guest", owedTo: null });
    expect(await titleOf("", "ar")).toMatchObject({ title: "اجتماع مع ضيف", owedTo: null });
    // a guest named like the owner or an agent is still only a title, never the owner or an agent as the party
    expect(await titleOf("reem")).toMatchObject({ title: "Meeting with reem", owedTo: null });
    expect(await titleOf("me")).toMatchObject({ title: "Meeting with me", owedTo: null });

    // the window: a day back to 366 days ahead
    const before = (await listOpenItems(u.email)).length;
    expect(await applyBooking(recOf(u), booking({}, Date.now() - DAY - 5 * MIN), hash)).toBe("noop");
    expect(await applyBooking(recOf(u), booking({}, Date.now() + 367 * DAY), hash)).toBe("noop");
    expect(await applyBooking(recOf(u), booking({ kind: "move", oldExternalId: "bk_none" }, Date.now() + 400 * DAY), hash)).toBe("noop");
    expect((await listOpenItems(u.email)).length).toBe(before);
    expect(await applyBooking(recOf(u), booking({}, minuteFrom(-DAY + 10 * MIN)), hash)).toBe("created");
    expect(await applyBooking(recOf(u), booking({}, minuteFrom(365 * DAY)), hash)).toBe("created");
    // an ignore is a no-op
    expect(await applyBooking(recOf(u), { kind: "ignore", externalId: "", name: "", eventName: "", start: "", end: "" }, hash)).toBe("noop");
  });

  it("rule 592: move changes the same item's start, end and remindAt; Calendly reschedule in both arrival orders leaves one moved item; an unknown id on move creates, on cancel is noop; cancel removes the item and a second cancel is noop", async () => {
    const u = await dubaiOwner();
    const rec = recOf(u);
    const hash = newHash();
    const a = booking();
    expect(await applyBooking(rec, a, hash)).toBe("created");
    const id = (await claimOf(u.email, "calcom", a.externalId))!;
    // Cal.com reschedule: a new uid naming the old one
    const newStart = minuteFrom(5 * DAY);
    const mv = booking({ kind: "move", externalId: "bk_new_uid", oldExternalId: a.externalId }, newStart);
    expect(await applyBooking(rec, mv, hash)).toBe("moved");
    const open = await listOpenItems(u.email);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id, dueAt: iso(newStart), remindAt: iso(newStart + 30 * MIN), allDay: false, rev: 2 });
    expect(await claimOf(u.email, "calcom", "bk_new_uid")).toBe(id);
    // the same move delivered again still names the one item
    expect(await applyBooking(rec, mv, hash)).toBe("moved");
    expect(await listOpenItems(u.email)).toHaveLength(1);
    // a move into the past leaves no reminder
    const past = minuteFrom(-2 * HOUR);
    expect(await applyBooking(rec, booking({ kind: "move", externalId: "bk_new_uid" }, past), hash)).toBe("moved");
    expect(await getItem(u.email, id)).toMatchObject({ dueAt: iso(past), remindAt: null });

    // a cancel under the new id removes the same item; a second cancel, and one under the old id, are no-ops
    const cancel = (externalId: string): Parsed => ({ kind: "cancel", externalId, name: "", eventName: "", start: "", end: "" });
    expect(await applyBooking(rec, cancel("bk_new_uid"), hash)).toBe("removed");
    const gone = (await getItem(u.email, id))!;
    expect(gone.deletedAt).toBeTruthy();
    expect(Date.parse(gone.expiresAt!) - Date.parse(gone.deletedAt!)).toBe(SEC_RESTORE_DAYS * DAY);
    expect(await auditOf(u.email)).toContainEqual(expect.objectContaining({ action: "booking_cancel", actor: "rule", via: "cron", id }));
    expect(await applyBooking(rec, cancel("bk_new_uid"), hash)).toBe("noop");
    expect(await applyBooking(rec, cancel(a.externalId), hash)).toBe("noop");
    // a cancel of a booking never seen is a no-op; a move of one never seen creates it, and its cancel finds it
    expect(await applyBooking(rec, cancel("bk_never"), hash)).toBe("noop");
    const fresh = booking({ kind: "move", externalId: "bk_fresh", oldExternalId: "bk_unknown_old" });
    expect(await applyBooking(rec, fresh, hash)).toBe("created");
    expect(await listOpenItems(u.email)).toHaveLength(1);
    // both of its ids name the one item, so a cancel under either finds it
    expect(await claimOf(u.email, "calcom", "bk_unknown_old")).toBe(await claimOf(u.email, "calcom", "bk_fresh"));
    expect(await applyBooking(rec, cancel("bk_fresh"), hash)).toBe("removed");
    expect(await listOpenItems(u.email)).toHaveLength(0);
    // a moved or cancelled booking whose item the owner closed is left as the owner left it
    const done = booking();
    expect(await applyBooking(rec, done, hash)).toBe("created");
    const doneId = (await claimOf(u.email, "calcom", done.externalId))!;
    expect((await changeItem(u.email, doneId, { action: "complete", result: "met" }, { actor: "owner", via: "web" })).ok).toBe(true);
    expect(await applyBooking(rec, booking({ kind: "move", externalId: "bk_done2", oldExternalId: done.externalId }), hash)).toBe("noop");
    expect(await applyBooking(rec, cancel(done.externalId), hash)).toBe("noop");
    expect(await getItem(u.email, doneId)).toMatchObject({ deletedAt: null, result: "met" });

    // Calendly: the create of the new invitee (naming the old) and the cancel of the old (flagged as a reschedule), in both orders
    const cyStart = minuteFrom(4 * DAY), cyNew = minuteFrom(6 * DAY);
    const setCy = (o: any, s: string, e: string) => { o.payload.scheduled_event.start_time = s; o.payload.scheduled_event.end_time = e; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const created = parseCalendly(shifted("booking-calendly-created", cyStart, setCy));
    const moved = parseCalendly(shifted("booking-calendly-created-rescheduled", cyNew, setCy));
    const cancelled = parseCalendly(shifted("booking-calendly-canceled-rescheduled", cyStart, setCy));
    expect(moved.kind).toBe("move");
    for (const order of [[cancelled, moved], [moved, cancelled]]) {
      const v = await dubaiOwner();
      const r = recOf(v, { provider: "calendly" });
      expect(await applyBooking(r, created, hash)).toBe("created");
      const before = (await listOpenItems(v.email))[0];
      for (const p of order) await applyBooking(r, p, hash);
      const after = await listOpenItems(v.email);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: before.id, dueAt: iso(cyNew), remindAt: iso(cyNew + 30 * MIN) });
      expect((await db.smembers(SEC_KEYS.all(v.email)))).toHaveLength(1);
      // a later cancel of the new invitee removes that same item
      expect(await applyBooking(r, { kind: "cancel", externalId: moved.externalId, name: "", eventName: "", start: "", end: "" }, hash)).toBe("removed");
      expect(await listOpenItems(v.email)).toHaveLength(0);
    }

    // a claim whose value names no item creates and removes nothing
    await db.set(`sec:book:ext:${u.email}:calcom:bk_odd`, "pending", 60);
    expect(await applyBooking(rec, cancel("bk_odd"), hash)).toBe("noop");
    expect(await applyBooking(rec, booking({ kind: "move", externalId: "bk_odd" }), hash)).toBe("noop");
    expect(await claimOf(u.email, "calcom", "bk_odd")).toBe("pending");

    // A booking claimed but not yet written (its creation died, or is still running):
    const claimRaw = (externalId: string) => {
      const sid = `s${randomBytes(8).toString("hex")}`;
      return db.set(`sec:book:ext:${u.email}:calcom:${externalId}`, sid, 3600).then(() => sid);
    };
    // a cancel marks the claim under the item's lock, so the creation never happens, and a later move creates nothing
    const late = booking();
    const lateId = await claimRaw(late.externalId);
    expect(await applyBooking(rec, cancel(late.externalId), hash)).toBe("noop");
    expect(await applyBooking(rec, late, hash)).toBe("noop");
    expect(await applyBooking(rec, booking({ kind: "move", externalId: "bk_late_new", oldExternalId: late.externalId }), hash)).toBe("noop");
    expect(await getItem(u.email, lateId)).toBeNull();
    // a move writes it at the claimed id with the new times and claims its new id; the original create, delivered late, is a no-op
    const early = booking();
    const earlyId = await claimRaw(early.externalId);
    const earlyAt = minuteFrom(7 * DAY);
    expect(await applyBooking(rec, booking({ kind: "move", externalId: "bk_early_new", oldExternalId: early.externalId }, earlyAt), hash)).toBe("created");
    expect(await getItem(u.email, earlyId)).toMatchObject({ dueAt: iso(earlyAt), source: "booking" });
    expect(await claimOf(u.email, "calcom", "bk_early_new")).toBe(earlyId);
    expect(await applyBooking(rec, early, hash)).toBe("noop");
    expect((await listOpenItems(u.email)).filter((x) => x.id === earlyId)).toHaveLength(1);

    // a move never overwrites a claim that names another item: it moves the item its previous id names
    const x = booking(), y = booking();
    expect(await applyBooking(rec, x, hash)).toBe("created");
    expect(await applyBooking(rec, y, hash)).toBe("created");
    const [xId, yId] = await Promise.all([claimOf(u.email, "calcom", x.externalId), claimOf(u.email, "calcom", y.externalId)]);
    const xAt = minuteFrom(9 * DAY);
    expect(await applyBooking(rec, booking({ kind: "move", externalId: y.externalId, oldExternalId: x.externalId }, xAt), hash)).toBe("moved");
    expect(await claimOf(u.email, "calcom", y.externalId)).toBe(yId);
    expect(await getItem(u.email, xId!)).toMatchObject({ dueAt: iso(xAt) });
    expect((await getItem(u.email, yId!))!.rev).toBe(1);
  });

  it("rule 593: removeBySystem sets the same restore window and audit as deleteNextCopy, which now uses it and behaves as before; the per-link cap of 60 creations a day stops at 60 and does not spend sec:create for the 61st; the owner's own 200 a day still applies", async () => {
    const u = await newUser("bkrm");
    const make = async (raw: Record<string, unknown>): Promise<SecItem> => {
      const r = await createItem(u, raw, { actor: "owner", via: "web", source: "owner" });
      if (!r.ok) throw new Error(r.error);
      return r.item;
    };
    const SYS = { actor: "rule", via: "cron" } as const;
    const it = await make({ title: "Call", dueAt: iso(minuteFrom(DAY)), remindAt: iso(minuteFrom(DAY / 2)) });
    expect(await db.zscore(SEC_KEYS.due(u.email), it.id)).not.toBeNull();
    expect(await removeBySystem(u.email, it.id, SYS, "booking_cancel")).toBe("deleted");
    const del = (await getItem(u.email, it.id))!;
    expect(del).toMatchObject({ rev: 2, deletedAt: expect.any(String) });
    expect(Date.parse(del.expiresAt!) - Date.parse(del.deletedAt!)).toBe(SEC_RESTORE_DAYS * DAY);
    expect(await db.zscore(SEC_KEYS.open(u.email), it.id)).toBeNull();
    expect(await db.zscore(SEC_KEYS.due(u.email), it.id)).toBeNull();
    expect(await db.zscore(SEC_KEYS.deleted(u.email), it.id)).toBe(Date.parse(del.expiresAt!));
    expect((await auditOf(u.email)).filter((l) => l.action === "booking_cancel")).toEqual([expect.objectContaining({ actor: "rule", via: "cron", id: it.id })]);
    // already deleted, missing, or not an item id: "gone", nothing written
    expect(await removeBySystem(u.email, it.id, SYS, "booking_cancel")).toBe("gone");
    expect(await removeBySystem(u.email, "s0000000000000000", SYS, "booking_cancel")).toBe("gone");
    expect(await removeBySystem(u.email, "../x", SYS, "booking_cancel")).toBe("gone");
    expect((await getItem(u.email, it.id))!.rev).toBe(2);
    // a guard that refuses: "kept", nothing written
    const keep = await make({ title: "Keep" });
    expect(await removeBySystem(u.email, keep.id, SYS, "booking_cancel", { only: () => false })).toBe("kept");
    expect((await getItem(u.email, keep.id))!).toMatchObject({ rev: 1, deletedAt: null });
    // another holder of the item's lock: "failed", nothing written
    expect(await db.lock(SEC_KEYS.lock(u.email, keep.id), 10)).toBe(true);
    try {
      expect(await removeBySystem(u.email, keep.id, SYS, "booking_cancel")).toBe("failed");
    } finally {
      await db.unlock(SEC_KEYS.lock(u.email, keep.id));
    }
    expect((await getItem(u.email, keep.id))!.deletedAt).toBeNull();

    // deleteNextCopy (a reopen of a closed recurring copy) goes through it: the same window, its own audit line by the rule
    const OWN = { actor: "owner", via: "web" } as const;
    const daily = await make({ title: "Daily", dueAt: iso(minuteFrom(DAY)), repeat: { every: "day" } });
    const closed = await changeItem(u.email, daily.id, { action: "complete", result: "done" }, OWN);
    if (!closed.ok) throw new Error(closed.error);
    const next = closed.item.nextId!;
    expect((await changeItem(u.email, daily.id, { action: "reopen" }, OWN)).ok).toBe(true);
    const nx = (await getItem(u.email, next))!;
    expect(Date.parse(nx.expiresAt!) - Date.parse(nx.deletedAt!)).toBe(SEC_RESTORE_DAYS * DAY);
    expect(nx.rev).toBe(2);
    expect((await auditOf(u.email)).find((l) => l.action === "series_reopen")).toMatchObject({ actor: "rule", via: "web", id: next });

    // the per-link cap: 60 creations a day for one link; the 61st is a no-op that spends nothing of the owner's 200
    const v = await newUser("bkcap");
    const rec = recOf(v);
    const hash = newHash();
    const out = await Promise.all(Array.from({ length: 60 }, () => applyBooking(rec, booking(), hash)));
    expect(out.every((r) => r === "created")).toBe(true);
    expect(await db.get(`rate:sec:create:${v.email}`)).toBe(60);
    const extra = booking();
    expect(await applyBooking(rec, extra, hash)).toBe("noop");
    expect(await db.get(`rate:sec:create:${v.email}`)).toBe(60);
    expect(await listOpenItems(v.email)).toHaveLength(60);
    // its claim is released: a refusal is a no-op the provider does not retry, and nothing is left claimed for it
    expect(await claimOf(v.email, "calcom", extra.externalId)).toBeNull();
    // another link of the same account has its own 60
    expect(await applyBooking(rec, booking(), newHash())).toBe("created");

    // the owner's own 200 a day still applies under the link cap
    const w = await newUser("bkown");
    await db.set(`rate:sec:create:${w.email}`, 200, 86400);
    const p = booking();
    expect(await applyBooking(recOf(w), p, newHash())).toBe("noop");
    expect(await listOpenItems(w.email)).toHaveLength(0);
    expect(await claimOf(w.email, "calcom", p.externalId)).toBeNull();
  });
});

describe("booking webhook (rules 594-595)", () => {
  const MIN = 60_000, DAY = 864e5;
  const iso = (ms: number) => new Date(ms).toISOString();
  const minuteFrom = (ms: number) => Math.ceil((Date.now() + ms) / MIN) * MIN;
  let ipN = 0;
  /** A fresh client address per use, so one test's per-IP bucket never touches another's. */
  const nextIp = () => { const n = ++ipN; return `10.7.${n >> 8}.${n & 255}`; };
  /** A live link: owner, plain token, hash and the derived signing key. */
  const link = async (provider: "calcom" | "calendly" = "calcom") => {
    const u = await newUser("bkroute");
    const token = await createBook(u.email, u.email, provider, "en");
    if (token === "busy") throw new Error("busy");
    const hash = hashBookToken(token);
    return { u, token, hash, key: bookingKey(hash) };
  };
  const calcomSig = (body: string, key: string) => ({ "x-cal-signature-256": hex(key, body) });
  const calendlySig = (body: string, key: string, t = Math.floor(Date.now() / 1000)) => ({ "calendly-webhook-signature": `t=${t},v1=${hex(key, `${t}.${body}`)}` });
  const post = (token: string, body: string, headers: Record<string, string> = {}, ip = nextIp()) =>
    bookingRoute.POST(new Request(`http://x/api/secretary/booking/${token}`, { method: "POST", headers: { "x-real-ip": ip, "content-type": "application/json", ...headers }, body }), params({ token }));
  const calcomCreate = (startMs: number, uid: string) => {
    const o = clone(fx("booking-calcom-created")) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    o.payload.uid = uid; o.payload.startTime = iso(startMs); o.payload.endTime = iso(startMs + 30 * MIN);
    return o;
  };
  const calendlyShift = (name: string, startMs: number) => {
    const o = clone(fx(name)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    o.payload.scheduled_event.start_time = iso(startMs); o.payload.scheduled_event.end_time = iso(startMs + 30 * MIN);
    return o;
  };
  const empty404 = async (r: Response) => { expect(r.status).toBe(404); expect(await r.text()).toBe(""); };

  it("rule 594: malformed token, unknown token, revoked link, a login no longer holding the scope, a bad signature and a missing signature all give the same empty 404; a malformed token reads nothing from the store; a body over 64 KB is refused before parsing; the signature is checked against the raw body", async () => {
    const ip = nextIp();
    const { u, token, key } = await link();
    const body = JSON.stringify(calcomCreate(minuteFrom(2 * DAY), "bk_594_ok"));
    expect((await post(token, body, calcomSig(body, key))).status).toBe(200);
    expect(await listOpenItems(u.email)).toHaveLength(1);

    // A malformed token reads nothing and counts nothing, whatever the body and headers say.
    const get = vi.spyOn(db, "get");
    const limit = vi.spyOn(rate, "allow");
    const responses: Response[] = [];
    try {
      for (const bad of ["x", "a".repeat(42), "a".repeat(44), token.replace(/.$/, "!"), "."]) responses.push(await post(bad, body, calcomSig(body, key), ip));
      expect(get).not.toHaveBeenCalled();
      expect(limit).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      limit.mockRestore();
    }

    // A body over 64 KB is refused before anything else: no rate count, no store read, even under a valid signature.
    const big = JSON.stringify({ ...calcomCreate(minuteFrom(3 * DAY), "bk_594_big"), pad: "x".repeat(70_000) });
    expect(big.length).toBeGreaterThan(64 * 1024);
    const get2 = vi.spyOn(db, "get");
    const limit2 = vi.spyOn(rate, "allow");
    try {
      responses.push(await post(token, big, calcomSig(big, key), ip));
      expect(get2).not.toHaveBeenCalled();
      expect(limit2).not.toHaveBeenCalled();
    } finally {
      get2.mockRestore();
      limit2.mockRestore();
    }
    expect(await listOpenItems(u.email)).toHaveLength(1);

    // Unknown token.
    responses.push(await post(randomBytes(32).toString("base64url"), body, calcomSig(body, key), ip));
    // Bad signatures: wrong key, altered body, missing header, empty header, the other provider's header, an over-long header.
    const fresh = JSON.stringify(calcomCreate(minuteFrom(4 * DAY), "bk_594_sig"));
    responses.push(await post(token, fresh, calcomSig(fresh, "k".repeat(64)), ip));
    responses.push(await post(token, fresh + " ", calcomSig(fresh, key), ip));
    responses.push(await post(token, fresh, {}, ip));
    responses.push(await post(token, fresh, { "x-cal-signature-256": "" }, ip));
    responses.push(await post(token, fresh, calendlySig(fresh, key), ip));
    responses.push(await post(token, fresh, { "x-cal-signature-256": `${hex(key, fresh)}${"0".repeat(600)}` }, ip));
    // The signature covers the raw bytes: the same JSON, pretty-printed, under the compact body's signature is refused;
    // signed as sent, it is accepted.
    const pretty = JSON.stringify(JSON.parse(fresh), null, 2);
    responses.push(await post(token, pretty, calcomSig(fresh, key), ip));
    expect(await listOpenItems(u.email)).toHaveLength(1);
    expect((await post(token, pretty, calcomSig(pretty, key), ip)).status).toBe(200);
    expect(await listOpenItems(u.email)).toHaveLength(2);

    // Calendly: stale timestamp, a v1 list far past any real header, a missing header.
    const cy = await link("calendly");
    const cyBody = JSON.stringify(calendlyShift("booking-calendly-created", minuteFrom(2 * DAY)));
    responses.push(await post(cy.token, cyBody, calendlySig(cyBody, cy.key, Math.floor(Date.now() / 1000) - 3600), ip));
    const crowd = Array.from({ length: 200 }, (_, i) => `v1=${String(i).padStart(64, "0")}`).join(",");
    responses.push(await post(cy.token, cyBody, { "calendly-webhook-signature": `${calendlySig(cyBody, cy.key)["calendly-webhook-signature"]},${crowd}` }, ip));
    responses.push(await post(cy.token, cyBody, {}, ip));
    responses.push(await post(cy.token, cyBody, calcomSig(cyBody, cy.key), ip));
    expect(await listOpenItems(cy.u.email)).toHaveLength(0);
    expect((await post(cy.token, cyBody, calendlySig(cyBody, cy.key), ip)).status).toBe(200);

    // Revoked link, and a login that no longer holds the scope (suspended, the way the feed's check refuses it).
    const gone = await link();
    await revokeBook(gone.u.email);
    responses.push(await post(gone.token, body, calcomSig(body, gone.key), ip));
    const sus = await link();
    expect((await post(sus.token, body, calcomSig(body, sus.key), ip)).status).toBe(200);
    await saveUser({ ...(await getUser(sus.u.email))!, suspended: true });
    responses.push(await post(sus.token, body, calcomSig(body, sus.key), ip));
    expect(await listOpenItems(sus.u.email)).toHaveLength(1);
    // A link made before the login's last password event is refused too.
    const old = await link();
    await saveUser({ ...(await getUser(old.u.email))!, sessionsAfter: new Date(Date.now() + 5000).toISOString() });
    responses.push(await post(old.token, body, calcomSig(body, old.key), ip));
    expect(await listOpenItems(old.u.email)).toHaveLength(0);

    expect(responses.length).toBeGreaterThanOrEqual(20);
    const first = [...responses[0].headers];
    expect(Object.fromEntries(first)).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    for (const r of responses) {
      await empty404(r);
      expect([...r.headers]).toEqual(first);
    }
  });

  it("rule 595: a signed create, move and cancel return 200 and act on rec.scope only; a signed unknown event is 200 and changes nothing; malformed JSON under a good signature is 400; a held lock is 503; IP and link buckets answer 429 with Retry-After before any item read", async () => {
    const { u, token, key } = await link();
    const other = await newUser("bkother");
    const start = minuteFrom(3 * DAY);
    const send = (o: unknown, headers?: Record<string, string>) => { const b = JSON.stringify(o); return post(token, b, headers ?? calcomSig(b, key)); };

    // create: the payload may name any scope it likes; only the record's is used
    const created = { ...calcomCreate(start, "bk_595_a"), scope: other.email, payload: { ...calcomCreate(start, "bk_595_a").payload, scope: other.email, email: other.email } };
    const r1 = await send(created);
    expect(r1.status).toBe(200);
    expect(Object.fromEntries(r1.headers)).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    const [it] = await listOpenItems(u.email);
    expect(it).toMatchObject({ source: "booking", title: "Meeting with Omar Example", dueAt: iso(start) });
    expect(await listOpenItems(other.email)).toHaveLength(0);
    // a replay is a 200 too
    expect((await send(created)).status).toBe(200);
    expect(await listOpenItems(u.email)).toHaveLength(1);

    // move (a Cal.com reschedule names the previous uid): the same item at the new time
    const resched = clone(fx("booking-calcom-rescheduled")) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const newStart = minuteFrom(5 * DAY);
    resched.payload.rescheduleUid = "bk_595_a"; resched.payload.uid = "bk_595_b";
    resched.payload.startTime = iso(newStart); resched.payload.endTime = iso(newStart + 30 * MIN);
    expect((await send(resched)).status).toBe(200);
    const moved = await listOpenItems(u.email);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ id: it.id, dueAt: iso(newStart) });

    // a signed unknown event is a 200 that changes nothing
    expect((await send({ triggerEvent: "MEETING_ENDED", payload: { uid: "bk_595_a" } })).status).toBe(200);
    expect((await send({ hello: "world" })).status).toBe(200);
    expect(await listOpenItems(u.email)).toHaveLength(1);

    // malformed JSON, and an empty body, under a good signature: 400
    for (const raw of ["{not json", ""]) {
      const r = await post(token, raw, calcomSig(raw, key));
      expect(r.status).toBe(400);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect(await listOpenItems(u.email)).toHaveLength(1);

    // a held item lock: 503 (the provider retries); released, the same delivery is handled
    const cancel = clone(fx("booking-calcom-cancelled")) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    cancel.payload.uid = "bk_595_b";
    expect(await db.lock(SEC_KEYS.lock(u.email, it.id), 30)).toBe(true);
    try {
      const busy = await send(cancel);
      expect(busy.status).toBe(503);
      expect(busy.headers.get("cache-control")).toBe("no-store");
      expect(await listOpenItems(u.email)).toHaveLength(1);
    } finally {
      await db.unlock(SEC_KEYS.lock(u.email, it.id));
    }
    expect((await send(cancel)).status).toBe(200);
    expect(await listOpenItems(u.email)).toHaveLength(0);
    expect((await send(cancel)).status).toBe(200);

    // a store failure before the item work is 503, not a 404 that tells the sender to give up
    const down = vi.spyOn(db, "get").mockRejectedValueOnce(new Error("store down"));
    try {
      expect((await send(created)).status).toBe(503);
    } finally {
      down.mockRestore();
    }

    // Calendly: create then cancel, signed its own way
    const cy = await link("calendly");
    const cyStart = minuteFrom(4 * DAY);
    const cyCreate = JSON.stringify(calendlyShift("booking-calendly-created", cyStart));
    expect((await post(cy.token, cyCreate, calendlySig(cyCreate, cy.key))).status).toBe(200);
    expect(await listOpenItems(cy.u.email)).toHaveLength(1);
    const cyCancel = JSON.stringify(calendlyShift("booking-calendly-canceled", cyStart));
    expect((await post(cy.token, cyCancel, calendlySig(cyCancel, cy.key))).status).toBe(200);
    expect(await listOpenItems(cy.u.email)).toHaveLength(0);

    // a record whose provider is neither (corrupt): 500, nothing done
    const bad = await link();
    const badHash = bad.hash;
    const rec = (await db.get<BookRecord>(BOOK_KEYS.rec(badHash)))!;
    await db.set(BOOK_KEYS.rec(badHash), { ...rec, provider: "zoom" });
    await db.set(BOOK_KEYS.of(rec.login, "zoom"), badHash);
    const bb = JSON.stringify(calcomCreate(minuteFrom(2 * DAY), "bk_595_bad"));
    const r500 = await post(bad.token, bb, calcomSig(bb, bad.key));
    expect(r500.status).toBe(500);
    expect(await listOpenItems(bad.u.email)).toHaveLength(0);

    // buckets: the address bucket answers 429 before the record is read
    const ip = nextIp();
    await db.set(`rate:book:ip:${ip}`, 1200, 3600);
    const get = vi.spyOn(db, "get");
    try {
      const r = await post(token, JSON.stringify(created), {}, ip);
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("3600");
      expect(await r.text()).toBe("");
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
    // the link bucket: after the record is found, before the holds check, the signature and any item work
    const lim = await link();
    await db.set(`rate:book:t:${lim.hash}`, 120, 3600);
    const lockSpy = vi.spyOn(db, "lock");
    try {
      const lb = JSON.stringify(calcomCreate(minuteFrom(2 * DAY), "bk_595_lim"));
      const r = await post(lim.token, lb, calcomSig(lb, lim.key));
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("3600");
      expect(await r.text()).toBe("");
      // an unsigned call hits the same bucket first: the 429 shows a live record exists, as the feed's does
      expect((await post(lim.token, lb, {})).status).toBe(429);
      expect(lockSpy).not.toHaveBeenCalled();
      expect(await listOpenItems(lim.u.email)).toHaveLength(0);
    } finally {
      lockSpy.mockRestore();
    }
  });
});
