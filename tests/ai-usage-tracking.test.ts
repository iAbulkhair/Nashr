import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { db } from "@/lib/db";
import { currentUser, sc, type User } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { wipeAccount } from "@/lib/account";
import { wsKey } from "@/lib/keys";
import { monthKey } from "@/lib/credits";
import { getUsageBreakdown, meter, meterRender, rankAccounts, usageMonthKeys, usageRankKey, usageWho } from "@/lib/usage";
import { clientRanking, isMonth, ownerView } from "@/lib/usage-report";
import { adminSignIn, jar, newMember, newUser, signIn, signOut } from "./helpers/session";
import * as usageRoute from "@/app/api/usage/route";
import * as clientsRoute from "@/app/api/admin/usage/clients/route";

/**
 * Per-client AI usage (rules 2900-2909) and the ad-codes wipe (rule 2930). Every metered call of an account also adds its
 * calls and cost to four hashes under the account's month (`usage:{acct}:{m}:by:{person|brand|model|day}:{calls|usd_micro}`)
 * and its cost to the month's ranking (`usage:_all:{m}:rank`). The founder ranks accounts by cost; an owner or admin
 * sees their own requests and shares, never a dollar figure.
 */
const SONNET = "claude-sonnet-5-5";
const usage = { input_tokens: 1000, output_tokens: 200 };
const KEY = "usage-tracking-admin-key-0123456789";
const u = (actor?: User["actor"]): Pick<User, "email" | "actor"> => ({ email: "o@test.example", actor });

beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { signOut(); });

describe("rule 2901: usageWho names who ran a call, never from the request", () => {
  it("maps each actor kind to a fixed person value, and a scope to its brand", () => {
    expect(usageWho(u({ kind: "owner" } as User["actor"]))).toEqual({ person: "owner" });
    expect(usageWho(u({ kind: "member", email: "Sara@Test.Example", role: "member" } as User["actor"]))).toEqual({ person: "member:sara@test.example" });
    expect(usageWho(u({ kind: "founder", impersonating: "x" } as User["actor"]))).toEqual({ person: "support" });
    expect(usageWho(u({ kind: "token" } as User["actor"]))).toEqual({ person: "app" });
    expect(usageWho(u())).toEqual({ person: "system" });
    expect(usageWho(u({ kind: "owner" } as User["actor"]), "o@test.example")).toEqual({ person: "owner", brand: "default" });
    expect(usageWho(u({ kind: "owner" } as User["actor"]), "o@test.example#b2")).toEqual({ person: "owner", brand: "b2" });
  });
});

describe("rules 2902-2905: one metered call writes the four breakdowns and the ranking", () => {
  it("adds calls and cost per person, brand, model and day", async () => {
    const owner = await newUser("trk");
    const a = acct(owner);
    await meter(a, SONNET, "chat", usage, "noor", undefined, { person: "owner", brand: "default" });
    await meter(a, SONNET, "generate", usage, "noor", undefined, { person: "member:m@test.example", brand: "b2" });
    await meter(a, "not-a-catalog-model", "generate", usage, "noor", undefined, { person: "bad\u0001value" });
    const b = await getUsageBreakdown(a);
    const day = new Date().toISOString().slice(0, 10);
    expect(b.month).toBe(monthKey());
    expect(b.person.owner.calls).toBe(1);
    expect(b.person["member:m@test.example"].calls).toBe(1);
    // A malformed or missing person or brand counts as "unknown", so every breakdown adds up to the account's own total.
    expect(b.person.unknown.calls).toBe(1);
    expect(b.brand.default.calls).toBe(1);
    expect(b.brand.b2.calls).toBe(1);
    expect(b.brand.unknown.calls).toBe(1);
    expect(b.model[SONNET].calls).toBe(2);
    expect(b.model.other.calls).toBe(1);
    expect(b.day[day].calls).toBe(3);
    expect(b.person.owner.usd).toBeGreaterThan(0);
    const ranked = await rankAccounts();
    expect(ranked.find((r) => r.account === a)!.usd).toBeCloseTo(Object.values(b.day).reduce((s, x) => s + x.usd, 0), 6);
  });

  it("an anonymous call (no account) writes no ranking entry", async () => {
    const before = await rankAccounts(monthKey(), 500);
    await meter(undefined, SONNET, "tool", usage);
    expect(await rankAccounts(monthKey(), 500)).toEqual(before);
  });

  it("a render's cost moves the account up the ranking, and the founder's row splits model and media cost (rule 2905)", async () => {
    const owner = await newUser("trkm");
    await meterRender(acct(owner), 2.5);
    expect((await rankAccounts()).find((r) => r.account === acct(owner))!.usd).toBeCloseTo(2.5, 6);
    const row = (await clientRanking(monthKey())).find((r) => r.account === acct(owner))!;
    expect(row.mediaUsd).toBeCloseTo(2.5, 6);
    expect(row.modelUsd).toBe(0);
    expect(row.usd).toBeCloseTo(2.5, 6);
    expect(row.email).toBe(owner.email);
  });

  it("the ranking is sorted by cost and capped at 500 rows", async () => {
    const r = await rankAccounts(monthKey(), 10_000);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].usd).toBeGreaterThanOrEqual(r[i].usd);
    expect(readFileSync("src/lib/usage.ts", "utf8")).toMatch(/Math\.min\(limit, 500\)/);
  });
});

describe("rule 2904: deleting an account removes its breakdowns and its ranking entries", () => {
  it("usageMonthKeys lists the eight hashes, and wipeAccount removes them and the rank member", async () => {
    const owner = await newUser("trkw");
    const a = acct(owner);
    const keys = usageMonthKeys(a, monthKey());
    for (const d of ["person", "brand", "model", "day"]) for (const p of ["calls", "usd_micro"]) expect(keys).toContain(`usage:${a}:${monthKey()}:by:${d}:${p}`);
    await meter(a, SONNET, "chat", usage, "noor", undefined, { person: "owner", brand: "default" });
    expect((await rankAccounts()).some((r) => r.account === a)).toBe(true);
    await wipeAccount(a);
    expect(Object.keys((await getUsageBreakdown(a)).person)).toEqual([]);
    expect((await rankAccounts(monthKey(), 500)).some((r) => r.account === a)).toBe(false);
    expect(await db.get(usageRankKey(monthKey()))).toBeNull();
  });

  it("rule 2930: the scope's ad codes (adcodes:{scope}) go with the account", async () => {
    const owner = await newUser("trka");
    await db.set(wsKey.adCodes(sc(owner)), { x: 1 });
    await wipeAccount(acct(owner));
    expect(await db.get(wsKey.adCodes(sc(owner)))).toBeNull();
  });
});

describe("rule 2907: the owner view has requests and shares, never money", () => {
  it("ownerView drops every usd, orders days by date and the rest by requests", () => {
    const v = ownerView(
      { month: "2026-10", person: { owner: { calls: 3, usd: 9 }, "member:a@b.c": { calls: 1, usd: 1 } }, brand: { default: { calls: 4, usd: 10 } }, model: { [SONNET]: { calls: 4, usd: 10 } }, day: { "2026-10-02": { calls: 1, usd: 1 }, "2026-10-01": { calls: 3, usd: 9 } } },
      4,
      { noor: { calls: 4 }, sami: { calls: 0 } },
    );
    expect(JSON.stringify(v)).not.toMatch(/usd/);
    expect(v.person.map((r) => r.key)).toEqual(["owner", "member:a@b.c"]);
    expect(v.person[0].share).toBe(75);
    expect(v.day.map((r) => r.key)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(v.agent).toEqual([{ key: "noor", calls: 4, share: 100 }]);
    expect(v.total).toEqual({ calls: 4 });
  });

  it("isMonth takes YYYY-MM only", () => {
    for (const ok of ["2026-10", "1999-01", "2026-12"]) expect(isMonth(ok), ok).toBe(true);
    for (const bad of ["2026-13", "2026-1", "2026-00", "2026-10-01", "", 202610, null, "../x"]) expect(isMonth(bad), String(bad)).toBe(false);
  });

  it("the settings page and its panel show no dollar figure", () => {
    for (const f of ["src/app/[lang]/app/settings/usage/page.tsx", "src/components/app/settings/OwnerUsagePanel.tsx"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/usd|toFixed|"\$"|>\$/i);
    expect(readFileSync("src/app/[lang]/app/settings/usage/page.tsx", "utf8")).toMatch(/if \(!can\(u, "usage\.view"\)\) notFound\(\);/);
  });
});

describe("rules 2907-2908: GET /api/usage for the owner and admins; GET /api/admin/usage/clients for the founder", () => {
  const get = (q = "") => usageRoute.GET(new Request(`http://localhost/api/usage${q}`));

  it("signed out 401, a member 403, an admin and the owner 200 with the account's own month and no dollar figure", async () => {
    expect((await get()).status).toBe(401);
    const owner = await newUser("trkr");
    await meter(acct(owner), SONNET, "chat", usage, "noor", undefined, { person: "owner", brand: "default" });
    const member = await newMember(owner, "member", "trkrm", { shadow: false });
    const admin = await newMember(owner, "admin", "trkra", { shadow: false });
    await signIn(member.email);
    expect((await get()).status).toBe(403);
    await signIn(admin.email);
    expect((await get()).status).toBe(200);
    await signIn(owner.email);
    expect(acct((await currentUser())!)).toBe(acct(owner));
    const r = await get();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, month: monthKey(), total: { calls: 1 }, person: [{ key: "owner", calls: 1, share: 100 }], agent: [{ key: "noor", calls: 1, share: 100 }] });
    expect(JSON.stringify(body)).not.toMatch(/usd/);
  });

  it("a bad month is 400; another month reads that month only", async () => {
    const owner = await newUser("trkb");
    await signIn(owner.email);
    expect((await get("?month=2026-13")).status).toBe(400);
    const r = await get("?month=2001-01");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ month: "2001-01", total: { calls: 0 }, person: [] });
  });

  it("the founder's ranking needs the console; a customer session is refused", async () => {
    const owner = await newUser("trkc");
    await meter(acct(owner), SONNET, "chat", usage, "noor", undefined, { person: "owner" });
    await signIn(owner.email);
    const call = (q = "") => clientsRoute.GET(new Request(`http://localhost/api/admin/usage/clients${q}`));
    expect([401, 403]).toContain((await call()).status);
    jar().clear();
    await adminSignIn();
    const r = await call();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.month).toBe(monthKey());
    expect(body.rows.find((x: { account: string }) => x.account === acct(owner))).toMatchObject({ email: owner.email, calls: 1 });
    expect((await call("?month=nope")).status).toBe(400);
  });
});

describe("rule 2909: every customer-facing model call names who ran it", () => {
  it("the call sites pass usageWho", () => {
    const sites: Record<string, RegExp> = {
      "src/lib/chat.ts": /who: usageWho\(user, sc\(user\)\)/,
      "src/lib/generate-batch.ts": /meterWho: usageWho\(user, scope\)/,
      "src/lib/revise.ts": /meterWho: usageWho\(user, scope\)/,
      "src/lib/secretary-meeting.ts": /who: usageWho\(user, scope\)/,
      "src/app/api/onboard/route.ts": /usageWho\(u, scope\)/,
      "src/lib/media/start.ts": /usageWho\(u, sc\(u\)\)/,
      "src/app/api/tools/[tool]/route.ts": /who: usageWho\(u, u\.scope\)/,
      "src/app/api/instructions/test/route.ts": /meterWho: usageWho\(u, scope\)/,
    };
    for (const [f, re] of Object.entries(sites)) expect(readFileSync(f, "utf8"), f).toMatch(re);
  });
});
