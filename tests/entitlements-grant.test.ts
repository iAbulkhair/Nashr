import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSignIn, jar, json, newUser, params, signIn } from "./helpers/session";
import { getUser, saveUser, type Plan, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { ALL_VIDEO_MODELS, entitlements, parseVideoGrant, type EntitlementView } from "@/lib/entitlements";
import { seatLimit } from "@/lib/pricing";
import { TRIAL_VIDEO_MODELS } from "@/lib/media-catalog";

import * as plan from "@/app/api/admin/plan/route";
import * as adminUser from "@/app/api/admin/users/[email]/route";
import * as profileRoute from "@/app/api/profile/route";

/**
 * The founder's video grant (rule 783): `POST /api/admin/plan` `videoGrant: {until, note?}` opens every video model to
 * one account through the end of a UTC day, `null` clears it. The body is checked in code before the account is read
 * (400 `bad_grant`, nothing written, nothing logged), only `until` and `note` are read from it, the grant is written
 * under the user lock with the actor and the time, logged before and after, survives a plan change and is cleared only
 * by `null`. `parseVideoGrant` is the one check (src/lib/entitlements.ts). The founder's detail read (rule 784) carries the
 * account's entitlement view, and shows a grant that has run out as expired.
 */
const KEY = "grant-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
// The console's key session cookie, as the console page sends it (the same setup as tests/admin-deal.test.ts).
beforeEach(async () => { jar().clear(); await adminSignIn(); });

const headers = {};
const call = (email: string, body: Record<string, unknown>) => plan.POST(json("/api/admin/plan", "POST", { email, ...body }, headers));
const logLength = async () => (await db.lrange("admin:log", 0, -1)).length;
const lastLog = async () => JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { what: string; before: { plan: string; video: string }; after: { plan: string; video: string }; actor: string };
async function account(p: Plan, prefix = "grant"): Promise<User> {
  const u = await newUser(prefix);
  const x = { ...(await getUser(u.email))!, plan: p };
  await saveUser(x);
  return x;
}

const DAY = 86400_000;
/** The UTC YYYY-MM-DD day n days from now. */
const dayFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
/**
 * A day that does not exist, in the next few months, so that `Date.parse` rolls it forward to a real day that the range
 * checks accept: the 31st of the next month with 30 days, or 30 February. Without the round-trip check it would be taken.
 */
function impossibleDay(): string {
  const now = new Date();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const year = d.getUTCFullYear();
    if (d.getUTCMonth() === 1) return `${year}-02-30`;
    if ([3, 5, 8, 10].includes(d.getUTCMonth())) return `${year}-${month}-31`;
  }
  throw new Error("unreachable: every year has a 30-day month");
}

describe("the founder's video grant (rule 783)", () => {
  it("sets a dated video grant, logged before and after", async () => {
    const u = await account("trial");
    const until = dayFromNow(14);
    const r = await call(u.email, { videoGrant: { until, note: "demo for agency lead" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { user: { videoGrant: Record<string, unknown> | null } };
    const g = (await getUser(u.email))!.grants?.video;
    expect(g).toMatchObject({ value: "all", until, note: "demo for agency lead", by: "key" });
    expect(Date.parse(g!.at)).not.toBeNaN();
    expect(body.user.videoGrant).toEqual(g);
    const log = await lastLog();
    expect(log.what).toContain(`video:all@${until}`);
    expect([log.before.video, log.after.video]).toEqual(["plan", `all@${until}`]);
    expect(log.actor).toBe("key");
    // And the trial now includes every video model (rule 780), which is what the grant is for.
    expect(entitlements((await getUser(u.email))!).media.video).toEqual(ALL_VIDEO_MODELS);
  });

  it("reads only until and note from the body; a second grant replaces the first and logs the one it replaced", async () => {
    const u = await account("trial");
    const first = dayFromNow(5);
    const second = dayFromNow(30);
    expect((await call(u.email, { videoGrant: { until: first, value: "none", by: "someone else", at: "1999-01-01T00:00:00Z" } })).status).toBe(200);
    const g1 = (await getUser(u.email))!.grants!.video!;
    expect(g1).toMatchObject({ value: "all", by: "key", until: first });
    expect(Date.parse(g1.at), "the time is the server's, not the body's").toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
    expect(g1).not.toHaveProperty("note");

    expect((await call(u.email, { videoGrant: { until: second } })).status).toBe(200);
    expect((await getUser(u.email))!.grants!.video).toMatchObject({ until: second });
    const log = await lastLog();
    expect([log.before.video, log.after.video]).toEqual([`all@${first}`, `all@${second}`]);
  });

  it("a note is one line; a blank one is no note", async () => {
    const u = await account("trial");
    await call(u.email, { videoGrant: { until: dayFromNow(3), note: "  demo\n\tfor   the\r\nagency  " } });
    expect((await getUser(u.email))!.grants!.video!.note).toBe("demo for the agency");
    await call(u.email, { videoGrant: { until: dayFromNow(3), note: " \n " } });
    expect((await getUser(u.email))!.grants!.video).not.toHaveProperty("note");
    await call(u.email, { videoGrant: { until: dayFromNow(3), note: "x".repeat(200) } });
    expect((await getUser(u.email))!.grants!.video!.note).toHaveLength(200);
  });

  it("accepts tomorrow and 366 days ahead, the two ends of the range", async () => {
    const u = await account("trial");
    for (const n of [1, 366]) {
      const until = dayFromNow(n);
      expect((await call(u.email, { videoGrant: { until } })).status, until).toBe(200);
      expect((await getUser(u.email))!.grants!.video!.until).toBe(until);
    }
  });

  it("refuses a bad grant and writes nothing", async () => {
    const u = await account("trial");
    const n = await logLength();
    const bads: unknown[] = [
      { until: dayFromNow(0) }, { until: dayFromNow(-2) }, { until: dayFromNow(367) }, { until: "2026-13-40" }, { until: "soon" },
      { until: impossibleDay() },   // a day that does not exist is not rolled forward to one that does
      { until: dayFromNow(3).replace(/-/g, "/") }, { until: `${dayFromNow(3)}T00:00:00Z` }, { until: 20271231 },
      {}, "all", 5, true, [], [{ until: dayFromNow(3) }], false,
      { until: dayFromNow(3), note: "x".repeat(201) }, { until: dayFromNow(3), note: 5 }, { until: dayFromNow(3), note: { a: 1 } },
    ];
    for (const bad of bads) {
      const r = await call(u.email, { videoGrant: bad });
      expect([r.status, (await r.json()).error], JSON.stringify(bad)).toEqual([400, "bad_grant"]);
    }
    expect((await getUser(u.email))!.grants).toBeUndefined();
    expect(await logLength()).toBe(n);
  });

  it("a bad grant refuses the whole request: the plan change sent with it is not made, and it is decided before the account is read", async () => {
    const u = await account("trial");
    const n = await logLength();
    const r = await call(u.email, { plan: "pro", addCredits: 50, videoGrant: { until: "soon" } });
    expect([r.status, (await r.json()).error]).toEqual([400, "bad_grant"]);
    const after = (await getUser(u.email))!;
    expect(after.plan).toBe("trial");
    expect(after.credits).toBe(u.credits);
    expect(await logLength()).toBe(n);
    // An account that does not exist: the body is judged first, so a bad grant is 400 and a good one is 404.
    expect((await call("nobody-here@test.example", { videoGrant: { until: "soon" } })).status).toBe(400);
    expect((await call("nobody-here@test.example", { videoGrant: { until: dayFromNow(3) } })).status).toBe(404);
    expect(await logLength()).toBe(n);
  });

  it("null clears the grant; a plan change keeps it", async () => {
    const u = await account("trial");
    await call(u.email, { videoGrant: { until: dayFromNow(5) } });
    await call(u.email, { plan: "pro" });
    expect((await getUser(u.email))!.grants?.video).toBeTruthy();
    const r = await call(u.email, { videoGrant: null });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: { videoGrant: unknown } }).user.videoGrant).toBeNull();
    const after = (await getUser(u.email))!;
    expect(after.grants?.video).toBeUndefined();
    expect(after, "the empty grants object goes with its last grant").not.toHaveProperty("grants");
    const log = await lastLog();
    expect(log.what).toContain("video:plan");
    expect(log.before.video).toMatch(/^all@/);
    expect(log.after.video).toBe("plan");
  });

  it("clearing when there is no grant is harmless; an unrelated change leaves the grant and logs it unchanged", async () => {
    const u = await account("trial");
    expect((await call(u.email, { videoGrant: null })).status).toBe(200);
    expect((await getUser(u.email))!.grants).toBeUndefined();
    const until = dayFromNow(9);
    await call(u.email, { videoGrant: { until } });
    await call(u.email, { addCredits: 10 });
    expect((await getUser(u.email))!.grants!.video!.until).toBe(until);
    const log = await lastLog();
    expect(log.what).not.toContain("video:");
    expect([log.before.video, log.after.video]).toEqual([`all@${until}`, `all@${until}`]);
  });

  it("needs the founder, and a refused call writes and logs nothing", async () => {
    jar().clear();
    const u = await account("trial");
    const n = await logLength();
    expect((await call(u.email, { videoGrant: { until: dayFromNow(5) } })).status).toBe(401);
    expect((await call(u.email, { videoGrant: null })).status).toBe(401);
    expect((await getUser(u.email))!.grants).toBeUndefined();
    expect(await logLength()).toBe(n);
  });

  it("the owner's profile never shows the grant: it carries the founder and a private note", async () => {
    const u = await account("trial");
    await call(u.email, { videoGrant: { until: dayFromNow(12), note: "private note for the founder" } });
    await signIn(u.email);
    const text = JSON.stringify(await (await profileRoute.GET()).json());
    expect(text, "the owner is still served their record").toContain(u.email);
    expect(text).not.toContain("grants");
    expect(text).not.toContain("private note for the founder");
  });

  it("the GET row shows the grant, or null", async () => {
    const withGrant = await account("trial");
    const without = await account("trial");
    const until = dayFromNow(12);
    await call(withGrant.email, { videoGrant: { until, note: "for the demo" } });
    const rows = ((await (await plan.GET(json("/api/admin/plan", "GET", undefined, headers))).json()) as { users: { email: string; videoGrant: { until: string; value: string; note?: string; by: string } | null }[] }).users;
    expect(rows.find((r) => r.email === withGrant.email)!.videoGrant).toMatchObject({ value: "all", until, note: "for the demo", by: "key" });
    expect(rows.find((r) => r.email === without.email)!.videoGrant).toBeNull();
  });
});

describe("parseVideoGrant (rule 783)", () => {
  const NOW = Date.parse("2026-10-08T12:00:00Z");
  const at = (v: unknown) => parseVideoGrant(v, NOW);

  it("accepts a day after today through 366 days ahead, with an optional one-line note", () => {
    expect(at({ until: "2026-10-09" })).toEqual({ ok: true, until: "2026-10-09" });
    expect(at({ until: "2027-10-09", note: "  a\nb " })).toEqual({ ok: true, until: "2027-10-09", note: "a b" });
    expect(at({ until: "2026-10-09", note: null })).toEqual({ ok: true, until: "2026-10-09" });
  });

  it("refuses today, the past, past 366 days, and anything that is not a real day", () => {
    for (const until of ["2026-10-08", "2026-10-07", "2027-10-10", "2026-13-01", "2026-10-32", "26-10-09", "2026-1-9", ""]) {
      expect(at({ until }), until).toEqual({ ok: false });
    }
    expect(at(undefined)).toEqual({ ok: false });
    expect(at(null)).toEqual({ ok: false });
  });

  it("refuses an impossible calendar day instead of letting Date.parse roll it forward (ruling R8)", () => {
    // Both are in range once rolled forward (2026-11-31 is 2026-12-01, 2027-02-29 is 2027-03-01); only the round-trip catches them.
    for (const until of ["2026-11-31", "2027-02-29", "2027-02-30", "2027-04-31"]) expect(at({ until }), until).toEqual({ ok: false });
    // A real leap day is a day.
    expect(parseVideoGrant({ until: "2028-02-29" }, Date.parse("2028-02-01T00:00:00Z"))).toEqual({ ok: true, until: "2028-02-29" });
    expect(parseVideoGrant({ until: "2027-02-29" }, Date.parse("2027-02-01T00:00:00Z"))).toEqual({ ok: false });
  });
});

describe("the founder's detail carries the entitlement view (rule 784)", () => {
  const detail = async (email: string, h: Record<string, string> = headers) =>
    adminUser.GET(json("/api/admin/users/x", "GET", undefined, h), params({ email: encodeURIComponent(email) }));

  it("GET /api/admin/users/{email} answers entitlements with the plan's numbers, the use and the grant", async () => {
    const u = await account("pro");
    const until = dayFromNow(9);
    await call(u.email, { videoGrant: { until, note: "for the demo" } });
    const body = (await (await detail(u.email)).json()) as { ok: boolean; user: User; entitlements: EntitlementView };
    const v = body.entitlements;
    expect(body.ok).toBe(true);
    expect(v.ent.seats).toBe(seatLimit(u));
    expect(v.ent.credits.monthly).toBe(entitlements(u).credits.monthly);
    expect(v.ent.media.video).toEqual(ALL_VIDEO_MODELS);
    expect(v.used.seats).toBe(1);
    expect(v.used.credits).toBe((await getUser(u.email))!.credits);
    expect(v.used.chat).toMatchObject({ used: 0, allowance: v.ent.chat.monthly, period: "month" });
    expect(v.resetsAt).toMatch(/^\d{4}-\d{2}-01$/);
    expect(v.grants.video).toMatchObject({ value: "all", until, note: "for the demo", by: "key", expired: false });
  });

  it("carries the plan's own values as base beside the effective ones (ruling R12)", async () => {
    const u = await account("pro");
    await saveUser({ ...(await getUser(u.email))!, seats: 9 });
    const v = ((await (await detail(u.email)).json()) as { entitlements: EntitlementView }).entitlements;
    expect(v.base.seats).toBe(seatLimit({ plan: "pro" }));
    expect(v.ent.seats).toBe(9);
    expect(v.base.credits).toEqual(v.ent.credits);
  });

  it("a trial whose grant has run out reads as the trial's own list, with the grant marked expired", async () => {
    const u = await account("trial");
    await saveUser({ ...(await getUser(u.email))!, grants: { video: { value: "all", until: dayFromNow(-3), by: "key", at: "2026-01-01T00:00:00.000Z" } } });
    const v = ((await (await detail(u.email)).json()) as { entitlements: EntitlementView }).entitlements;
    expect(v.ent.media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(v.grants.video).toMatchObject({ value: "all", expired: true });
    expect(v.resetsAt).toBeNull();
  });

  it("is the founder's only: without the key the detail is 401 and carries no entitlements", async () => {
    const u = await account("pro");
    jar().clear();
    const r = await detail(u.email, {});
    expect(r.status).toBe(401);
    expect(JSON.stringify(await r.json())).not.toContain("entitlements");
  });
});
