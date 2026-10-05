import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newMember, newUser, signIn } from "./helpers/session";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { can, MIN_ROLE } from "@/lib/roles";
import {
  BOOK_KEYS, BOOK_PROVIDERS, BOOK_TOKEN, bookingKey, createBook, getBookStatus, hashBookToken, resolveBook, revokeBook, revokeBooks,
} from "@/lib/booking-token";
import { parseCalcom, parseCalendly, verifyCalcomSignature, verifyCalendlySignature, type Parsed } from "@/lib/secretary-booking";

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
