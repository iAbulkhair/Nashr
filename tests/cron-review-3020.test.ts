import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aidOf, ownerOf } from "@/lib/membership";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { newMember as helperNewMember, newOpaqueUser, newUser as helperNewUser, params, signOut } from "./helpers/session";

const safeFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit, opts?: { httpsOnly?: boolean }) => Promise<Response>>());
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

// Mail goes through a counted Resend stand-in that can be told to refuse (as tests/mail-once.test.ts does).
const sent: { to: string; subject: string }[] = [];
let accept = true;
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (msg: { to: string; subject: string }) => {
        if (!accept) return { data: null, error: { name: "validation_error", message: "refused" } };
        sent.push({ to: msg.to, subject: msg.subject });
        return { data: { id: "re_ok" }, error: null };
      },
    };
  },
}));

import { generateKeyPairSync } from "node:crypto";
import { saveUser, getUser, type Actor, type User } from "@/lib/auth";
import { sc } from "@/lib/auth";
import { saveBrand, type Brand } from "@/lib/brand";
import { db } from "@/lib/db";
import { storedPersonId } from "@/lib/keys";
import { removeMember } from "@/lib/team";
import { listSubscriptions, pushForActivity, saveSubscription } from "@/lib/push";
import { createFeed } from "@/lib/feed-token";
import * as feedRoute from "@/app/api/secretary/feed/[token]/route";
import * as dailyRoute from "@/app/api/cron/daily/route";
import { chargeOnce } from "@/lib/credits";
import { RUN_STALE_MS, deliverRun } from "@/lib/run-receipt";
import { sweepHolds } from "@/lib/hold-sweep";
import { periodOf, routineClaim } from "@/lib/routines";
import { activeSeasons, whiteFridayDay } from "@/lib/seasons";
import { confirmedMarker, onceKey, sendOnce } from "@/lib/notify";
import { acct } from "@/lib/account-id";
import { saveSchedule } from "@/lib/schedule";
import { SEC_KEYS, newSecId } from "@/lib/secretary";
import type { SecItem } from "@/lib/secretary-agenda";

/**
 * Rules 3020-3026: the scheduled-work review. docs/system/tests/3020-cron-review.md lists what each test pins.
 */
const read = (p: string) => readFileSync(p, "utf8");
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

// A real P-256 pair for the VAPID token, as in tests/agent-status-push.test.ts.
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = pair.privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
const PUB = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const pushOnEnv = () => { vi.stubEnv("PUSH_VAPID_PUBLIC_KEY", PUB); vi.stubEnv("PUSH_VAPID_PRIVATE_KEY", jwk.d); };
let n = 0;
const ep = () => `https://fcm.googleapis.com/fcm/send/dev-${++n}-${Math.random().toString(36).slice(2)}`;

const newUser = (prefix?: string) => helperNewUser(prefix);
const newMember = (owner: User) => helperNewMember(owner, "member", "m");
const ownerActor = (u: User): Actor => ({ kind: "owner", pid: storedPersonId(u.email), home: true, email: u.email, name: u.name, lang: u.lang, role: "owner" });

beforeEach(() => {
  safeFetch.mockReset();
  safeFetch.mockResolvedValue(new Response(null, { status: 201 }));
  sent.length = 0;
  accept = true;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); signOut(); });

describe("rule 3020: a removed member's device gets no push", () => {
  it("the send reaches the owner's and the member's devices, then only the owner's after the removal; old rows are not needed to be cleaned", async () => {
    pushOnEnv();
    const owner = await newUser("p3020o");
    const m = await newMember(owner);
    const s = sc(owner);
    const ownerEp = ep(), memberEp = ep();
    await saveSubscription(s, owner.email.toLowerCase(), ownerEp, new Date(NOW));
    await saveSubscription(s, m.email.toLowerCase(), memberEp, new Date(NOW + 1000));
    const row = (kind: string) => ({ at: new Date().toISOString(), kind, agent: "noor", by: { kind: "owner" }, via: "app" }) as never;

    expect(await pushForActivity(s, [row("generated")])).toBe(2);
    expect(safeFetch.mock.calls.map((c) => c[0]).sort()).toEqual([ownerEp, memberEp].sort());

    safeFetch.mockClear();
    expect(await removeMember(owner, ownerActor(owner), m.email)).toEqual({ ok: true });
    // The row is still in the hash (the removal does not touch it); the send ignores it.
    expect((await listSubscriptions(s)).map((x) => x.endpoint)).toContain(memberEp);
    expect(await pushForActivity(s, [row("render_failed")])).toBe(1);
    expect(safeFetch.mock.calls.map((c) => c[0])).toEqual([ownerEp]);
  });
  it("only logins that still hold the workspace are sent to (source pin)", () => {
    expect(read("src/lib/push.ts")).toMatch(/loginHoldsWorkspace\(l, scope\)/);
  });
});

describe("rule 3021: the calendar feed's address limit counts misses only", () => {
  it("a live link answers from an address that already had 120 misses, and a miss past the limit is 429", async () => {
    const o = await newUser("f3021");
    const token = await createFeed({ pid: ownerOf(o), aid: aidOf(o), login: o.email, home: true }, sc(o), "en");
    const ip = "10.77.1.1";
    const call = (t: string) => feedRoute.GET(new Request(`http://x/api/secretary/feed/${t}`, { headers: { "x-forwarded-for": ip } }), params({ token: t }));
    for (let i = 0; i < 120; i++) expect((await call(randomBytes(32).toString("base64url"))).status).toBe(404);
    expect((await call(randomBytes(32).toString("base64url"))).status).toBe(429);
    expect((await call(token)).status, "a live link never meets the address bucket").toBe(200);
  });
  it("many live links fetched from one shared address are all served", async () => {
    const ip = "10.77.2.2";
    // One link per subscriber (a login has one), as a calendar service fetching for many users from one address.
    const tokens = await Promise.all(Array.from({ length: 12 }, async () => { const o = await newUser("f3021b"); return createFeed({ pid: ownerOf(o), aid: aidOf(o), login: o.email, home: true }, sc(o), "en"); }));
    for (const t of tokens) {
      const r = await feedRoute.GET(new Request(`http://x/api/secretary/feed/${t}`, { headers: { "x-forwarded-for": ip } }), params({ token: t }));
      expect(r.status).toBe(200);
    }
  });
});

describe("rule 3022: the signup nudge's marker belongs to the account", () => {
  it("sendOnce keys the marker by the first argument and mails the `to` address", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>");
    const owner = await newUser("o3022");
    expect(await sendOnce("a_marker3022", "nudge1", "s", "t", undefined, owner.email)).toBe("sent");
    expect(sent.at(-1)?.to).toBe(owner.email);
    expect(confirmedMarker(await db.get(onceKey("a_marker3022", "nudge1")))).toBe(true);
    expect(await db.get(onceKey(owner.email, "nudge1"))).toBeNull();
    expect(await sendOnce("a_marker3022", "nudge1", "s", "t", undefined, owner.email)).toBe("already");
  });
  it("the daily route marks an opaque account under its id, mails its address, and a nudge sent under the address counts as sent", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>");
    vi.stubEnv("CRON_SECRET", "cron-secret-3022");
    const a = await newOpaqueUser("n3022");
    const b = await newOpaqueUser("n3022b");
    const old = new Date(Date.now() - 3600e3).toISOString();
    await Promise.all([saveUser({ ...a, createdAt: old }), saveUser({ ...b, createdAt: old })]);
    expect(acct(a)).not.toBe(a.email);
    // b was nudged before this change: the marker sits under its address.
    await db.set(onceKey(b.email, "nudge1"), { sent: old }, 86400);
    const r = await dailyRoute.GET(new Request("https://nashr.test/api/cron/daily?chain=1", { headers: { authorization: "Bearer cron-secret-3022" } }));
    expect(r.status).toBe(200);
    expect(sent.filter((m) => m.to === a.email)).toHaveLength(1);
    expect(sent.filter((m) => m.to === b.email), "no second nudge").toHaveLength(0);
    expect(confirmedMarker(await db.get(onceKey(acct(a), "nudge1")))).toBe(true);
    expect(await db.get(onceKey(a.email, "nudge1"))).toBeNull();
  });
  it("the notification choices are read under the account, not the address (source pin)", () => {
    expect(read("src/app/api/cron/daily/route.ts")).toMatch(/readPrefs\(u\.scope \?\? acct\(u\), acct\(u\)\)/);
  });
});

describe("rule 3023: one daily email per workspace and day", () => {
  const BRAND: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };
  async function seedOverdue(scope: string) {
    const at = new Date().toISOString();
    const it: SecItem = { id: newSecId(), kind: "task", description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: new Date(Date.now() - 4 * 3600e3).toISOString(), allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [], createdAt: at, updatedAt: at, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, rev: 1, title: "Renew the licence" };
    await Promise.all([db.set(SEC_KEYS.item(scope, it.id), it), db.zadd(SEC_KEYS.open(scope), Date.parse(it.dueAt!), it.id), db.sadd(SEC_KEYS.all(scope), it.id)]);
  }
  const run = async (u: User) => {
    const day = new Date().toISOString().slice(0, 10);
    // A retry after a killed run: the batch's own done marker never got written.
    await Promise.all([db.del(`crondone:daily:${day}:${acct(u)}`), db.del(`crontry:daily:${day}:${acct(u)}`)]);
    const r = await dailyRoute.GET(new Request("https://nashr.test/api/cron/daily?chain=1", { headers: { authorization: "Bearer cron-secret-3023" } }));
    expect(r.status).toBe(200);
  };
  it("a rerun of the same day mails nothing again; a refused send is tried again", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-3023");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>");
    const u = await newUser("d3023");
    await saveBrand(acct(u), BRAND);
    await db.set(`profile:${acct(u)}`, { emails: "important" });
    await saveSchedule(acct(u), { followUps: false });
    await seedOverdue(acct(u));

    accept = false;
    await run(u);
    expect(sent.filter((m) => m.to === u.email)).toHaveLength(0);
    accept = true;
    await run(u);
    expect(sent.filter((m) => m.to === u.email), "the refused send released its claim").toHaveLength(1);
    await run(u);
    await run(u);
    expect(sent.filter((m) => m.to === u.email), "a killed-and-retried run does not mail twice").toHaveLength(1);
  });
});

describe("rule 3024: a late hold sweep keeps a routine that delivered", () => {
  const COST = 4;
  /** Charge every claim first (a charge drops holds older than `PAID_ONCE_MS`), then age them all in one write. */
  async function heldAll(u: User, claims: string[], ageMs: number) {
    for (const c of claims) await chargeOnce(acct(u), COST, { scope: acct(u), agent: "dana" }, c);
    const rec = (await getUser(acct(u)))!;
    const at = new Date(Date.now() - ageMs).toISOString();
    await db.set(`user:${acct(u)}`, { ...rec, paidOnce: Object.fromEntries(Object.entries(rec.paidOnce!).map(([k, v]) => [k, { ...v, at }])) });
    return at;
  }
  it("no receipt and a last-run marker minutes after the charge: kept; no marker, or one from a later run: refunded; a receipt still decides first", async () => {
    const u = await newUser("h3024");
    const before = (await getUser(acct(u)))!.credits;
    const age = 9 * 86400e3; // past the receipt's 7 days and the 8-day hold
    const kept = routineClaim(acct(u), "dana_weekly_report", "2026-10-04");
    const lost = routineClaim(acct(u), "razan_cash_forecast", "2026-10");
    const later = routineClaim(acct(u), "majed_monthly_review", "2026-10");
    const receipted = routineClaim(acct(u), "noor_cart_recovery", "2026-10-04");
    const at = await heldAll(u, [kept, lost, later, receipted], age);
    const atKept = at, atLater = at;
    await db.set(`routinelast:${acct(u)}:dana_weekly_report`, new Date(Date.parse(atKept) + 90e3).toISOString());
    // A later period's run says nothing about this claim.
    await db.set(`routinelast:${acct(u)}:majed_monthly_review`, new Date(Date.parse(atLater) + 5 * 86400e3).toISOString());
    await deliverRun(receipted, 600, ["t1"]);

    const r = await sweepHolds((await getUser(acct(u)))!);
    expect([...(r?.dropped ?? [])].sort()).toEqual([kept, receipted].sort());
    expect((r?.refunded ?? []).map((x) => x.claim).sort()).toEqual([lost, later].sort());
    expect((await getUser(acct(u)))!.credits).toBe(before - 2 * COST);
    expect(RUN_STALE_MS).toBeLessThan(age);
  });
});

describe("rule 3025: the secretary tick gives the calendars their own deadline", () => {
  it("sweepCalendars gets a deadline 60 s from the start, not the reminders' 40 s one (source pin)", () => {
    const src = read("src/app/api/cron/secretary/route.ts");
    expect(src).toMatch(/const CAL_BUDGET_TICK_MS = 60_000/);
    expect(src).toMatch(/sweepCalendars\(now, calDeadline\)/);
    expect(src).not.toMatch(/sweepCalendars\(now, deadline\)/);
    // Both sweeps start together, so a long reminder sweep cannot spend the calendars' window.
    expect(src).toMatch(/Promise\.all\(\[\s*sweepReminders/);
  });
});

describe("rule 3026: White Friday is the last Friday of November", () => {
  it("the date is computed for each year", () => {
    expect([2024, 2025, 2026, 2027, 2028, 2029].map(whiteFridayDay)).toEqual([29, 28, 27, 26, 24, 30]);
    for (const y of [2025, 2026, 2027, 2031]) expect(new Date(Date.UTC(y, 10, whiteFridayDay(y))).getUTCDay()).toBe(5);
  });
  it("the season counts down to it", () => {
    const left = (iso: string) => activeSeasons(new Date(iso)).find((s) => s.id === "white_friday")?.daysLeft;
    expect(left("2025-11-14T12:00:00Z")).toBe(14); // 28 Nov 2025
    expect(left("2027-11-12T12:00:00Z")).toBe(14); // 26 Nov 2027
    expect(left("2026-11-13T12:00:00Z")).toBe(14); // 27 Nov 2026
  });
});
