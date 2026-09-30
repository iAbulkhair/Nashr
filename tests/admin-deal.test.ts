import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jar, json, newUser, signIn } from "./helpers/session";
import { getUser, saveUser, seatLimit, type Plan, type User } from "@/lib/auth";
import { monthKey, renewIfDue } from "@/lib/credits";
import { db } from "@/lib/db";
import { saveTask, type Task } from "@/lib/brand";
import { AGENCY_MIN, PLAN_CREDITS, PLAN_SEATS } from "@/lib/pricing";

import * as plan from "@/app/api/admin/plan/route";
import * as exportRoute from "@/app/api/admin/export/route";
import * as profileRoute from "@/app/api/profile/route";

/**
 * The founder console's plan API with Agency deals (rules 223 and 224): a deal is validated in code against the
 * Business rate (src/lib/pricing.ts `parseDeal`), lives only on Agency, is cleared when the account leaves Agency, is
 * logged before and after, and is what renewal and a plan change grant (`allowanceOf`). addCredits is bounded.
 */
const KEY = "deal-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
// The console's cookie, as the console page sends it. Not the x-admin-key header: that one is throttled per IP
// (30 guesses in 15 minutes), and every call in this file comes from the same test address.
beforeEach(() => { jar().clear(); jar().set("nashr_admin", KEY); });

const headers = {};
const call = (email: string, body: Record<string, unknown>) => plan.POST(json("/api/admin/plan", "POST", { email, ...body }, headers));
/** A body sent as raw text, for what JSON.stringify cannot write (1e999 parses to Infinity). */
const raw = (text: string) => plan.POST(new Request("https://nashr.test/api/admin/plan", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text }));
const logLength = async () => (await db.lrange("admin:log", 0, -1)).length;
const lastLog = async () => JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { what: string; before: { deal: string; seats: number }; after: { deal: string; credits: number; seats: number }; actor: string };
async function account(p: Plan, prefix = "deal"): Promise<User> {
  const u = await newUser(prefix);
  const x = { ...(await getUser(u.email))!, plan: p };
  await saveUser(x);
  return x;
}

describe("an Agency deal is checked in code (rule 224)", () => {
  it("a deal below the Business rate, malformed or not in whole numbers is refused and writes nothing", async () => {
    const u = await account("agency");
    const logged = await logLength();
    const cases: [unknown, string][] = [
      [{ credits: 1501, priceSar: 999 }, "below_floor"],
      [{ credits: 1500, priceSar: 998 }, "below_floor"],
      [{ credits: 3004, priceSar: 2000 }, "below_floor"],
      [{ credits: 1000, priceSar: 5000 }, "below_floor"],
      [{ credits: "1500", priceSar: 999 }, "bad_deal"],
      [{ credits: 1500.5, priceSar: 999 }, "bad_deal"],
      [{ credits: 1500 }, "bad_deal"],
      [{ credits: 100_001, priceSar: 1_000_000 }, "bad_deal"],
      [[1500, 999], "bad_deal"],
      ["1500@999", "bad_deal"],
      [0, "bad_deal"],
    ];
    for (const [deal, error] of cases) {
      const res = await call(u.email, { deal });
      expect(res.status, JSON.stringify(deal)).toBe(400);
      expect(await res.json(), JSON.stringify(deal)).toEqual({ ok: false, error });
    }
    expect((await getUser(u.email))!.deal).toBeUndefined();
    expect(await logLength(), "a refused change is not logged as made").toBe(logged);
  });

  it("exactly the Business rate is accepted; a deal change alone keeps the balance and applies at renewal", async () => {
    const u = await account("agency");
    await saveUser({ ...(await getUser(u.email))!, credits: 1234 });
    const res = await call(u.email, { deal: { ...AGENCY_MIN, seats: 40, setBy: "someone else" }, reason: "signed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { deal: Record<string, unknown>; allowance: number; credits: number } };
    expect(body.user.deal).toMatchObject({ credits: 1500, priceSar: 999, setBy: "key" });
    expect(body.user.deal, "only credits and price are read from the body").not.toHaveProperty("seats");
    expect(body.user.allowance).toBe(1500);
    expect(body.user.credits).toBe(1234);

    expect((await call(u.email, { deal: { credits: 3003, priceSar: 2000 } })).status).toBe(200);
    const after = (await getUser(u.email))!;
    expect(after.deal).toMatchObject({ credits: 3003, priceSar: 2000 });
    expect(after.credits, "the balance waits for the renewal").toBe(1234);
    expect(await lastLog()).toMatchObject({ what: "deal:3003@2000", before: { deal: "1500@999" }, after: { deal: "3003@2000" }, actor: "key" });

    await saveUser({ ...after, renewedAt: "2020-01" });
    expect(await renewIfDue(u.email)).toBe(true);
    expect((await getUser(u.email))!.credits, "renewal grants the deal's credits (rule 223)").toBe(3003);
  });

  it("plan agency with a deal grants the deal at once and starts the renewal cycle", async () => {
    const u = await account("trial");
    const res = await call(u.email, { plan: "agency", deal: { credits: 3000, priceSar: 1998 } });
    expect(res.status).toBe(200);
    const x = (await getUser(u.email))!;
    expect(x.plan).toBe("agency");
    expect(x.credits).toBe(3000);
    expect(x.renewedAt).toBe(monthKey());
    expect(await lastLog()).toMatchObject({ what: "plan:agency deal:3000@1998", before: { deal: "none" }, after: { deal: "3000@1998", credits: 3000 } });
  });

  it("a deal on any other plan is refused, and so is a plan change away from Agency that carries one", async () => {
    for (const p of ["trial", "starter", "pro", "business"] as const) {
      const u = await account(p);
      const res = await call(u.email, { deal: AGENCY_MIN });
      expect(res.status, p).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "deal_needs_agency" });
      expect((await getUser(u.email))!.deal).toBeUndefined();
    }
    const a = await account("agency");
    await call(a.email, { deal: { credits: 2000, priceSar: 1332 } });
    const res = await call(a.email, { plan: "business", deal: AGENCY_MIN });
    expect(res.status).toBe(400);
    const x = (await getUser(a.email))!;
    expect(x.plan, "a refused request writes nothing").toBe("agency");
    expect(x.deal).toMatchObject({ credits: 2000, priceSar: 1332 });
  });

  it("leaving Agency clears the deal and its seats and logs both; coming back starts from Business", async () => {
    const u = await account("agency");
    // The console's Deal prompt sends the deal's seats with it: they live in the seat override.
    await call(u.email, { deal: { credits: 3003, priceSar: 2000 }, seats: 20 });
    expect(seatLimit((await getUser(u.email))!)).toBe(20);
    expect((await call(u.email, { plan: "pro" })).status).toBe(200);
    const x = (await getUser(u.email))!;
    expect(x.deal).toBeUndefined();
    expect(x.credits).toBe(PLAN_CREDITS.pro);
    expect(x.seats, "the deal's seats went with the deal").toBeUndefined();
    expect(seatLimit(x), "Pro's seats, not the deal's 20").toBe(PLAN_SEATS.pro);
    expect(await lastLog()).toMatchObject({ what: "plan:pro deal:none seats:plan", before: { deal: "3003@2000", seats: 20 }, after: { deal: "none", seats: PLAN_SEATS.pro } });
    expect((await call(u.email, { plan: "agency" })).status).toBe(200);
    const back = (await getUser(u.email))!;
    expect(back.credits, "Agency without a deal is Business's allowance").toBe(PLAN_CREDITS.business);
    expect(seatLimit(back), "and Business's seats").toBe(PLAN_SEATS.business);
  });

  it("a plan change away from Agency that sets seats keeps the seats it sets", async () => {
    const u = await account("agency");
    await call(u.email, { deal: { credits: 3003, priceSar: 2000 }, seats: 20 });
    expect((await call(u.email, { plan: "business", seats: 9 })).status).toBe(200);
    expect(seatLimit((await getUser(u.email))!)).toBe(9);
    expect((await lastLog()).what).toBe("plan:business deal:none seats:9");
  });

  it("deal null clears it and its seats, and the change is logged", async () => {
    const u = await account("agency");
    await call(u.email, { deal: { credits: 1500, priceSar: 1200 }, seats: 12 });
    const res = await call(u.email, { deal: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { deal: unknown; allowance: number; seats: number } }).user).toMatchObject({ deal: null, allowance: 1500, seats: PLAN_SEATS.business });
    expect((await getUser(u.email))!.deal).toBeUndefined();
    expect(await lastLog()).toMatchObject({ what: "deal:none seats:plan", before: { deal: "1500@1200", seats: 12 }, after: { deal: "none", seats: PLAN_SEATS.business } });
  });

  it("GET and the CSV export show the deal, the allowance and the deal price", async () => {
    const u = await account("agency");
    await call(u.email, { deal: { credits: 5000, priceSar: 3330 } });
    const rows = ((await (await plan.GET(json("/api/admin/plan", "GET", undefined, headers))).json()) as { users: Record<string, unknown>[] }).users;
    const row = rows.find((r) => r.email === u.email)!;
    expect(row).toMatchObject({ plan: "agency", deal: { credits: 5000, priceSar: 3330 }, allowance: 5000, priceSar: 3330 });
    expect(row.marginPct).not.toBeNull();
    const csv = await (await exportRoute.GET(json("/api/admin/export", "GET", undefined, headers))).text();
    expect(csv.split("\n").find((l) => l.includes(u.email)), "the deal column").toContain("5000@3330");
  });
});

describe("the owner's profile states the allowance the balance renews to (rule 223)", () => {
  it("an Agency deal's credits, Business's without one; the deal's terms without who set it", async () => {
    const u = await account("agency");
    await signIn(u.email);
    const read = async () => (await (await profileRoute.GET()).json()) as { allowance: number; user: Record<string, unknown> };
    expect((await read()).allowance).toBe(PLAN_CREDITS.business);
    jar().set("nashr_admin", KEY);
    await call(u.email, { deal: { credits: 4500, priceSar: 2997 } });
    const p = await read();
    expect(p.allowance).toBe(4500);
    expect(p.user.deal).toEqual({ credits: 4500, priceSar: 2997 });
    expect(JSON.stringify(p), "the founder console's actor is not shown to the customer").not.toContain("setBy");
  });
});

describe("the owner's usage table counts what renders really charged", () => {
  it("a premium image at 2 and a video at 12, not 1 per item; an image from before mediaCredits counts 1", async () => {
    const u = await account("pro", "media");
    await signIn(u.email);
    const base: Omit<Task, "id"> = { type: "social", channel: "instagram", title: "x", body: "x", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
    await Promise.all([
      saveTask(u.email, { ...base, id: "media-premium", imageUrl: "https://blob.example/1.png", imageModel: "img-premium", mediaCredits: 2 }, true),
      saveTask(u.email, { ...base, id: "media-video", videoUrl: "https://blob.example/2.mp4", videoModel: "vid-quick", mediaCredits: 12 }, true),
      saveTask(u.email, { ...base, id: "media-legacy", imageUrl: "https://blob.example/3.png" }, true),
    ]);
    const p = (await (await profileRoute.GET()).json()) as { images: number; mediaCredits: number };
    expect(p.images, "items with an image or a video").toBe(3);
    expect(p.mediaCredits).toBe(2 + 12 + 1);
  });
});

describe("credits the founder adds are finite and bounded", () => {
  it("1e999, a string or more than 100,000 either way is refused; a bounded number is added", async () => {
    const u = await account("pro");
    const before = (await getUser(u.email))!.credits;
    const inf = await raw(`{"email":"${u.email}","addCredits":1e999}`);
    expect(inf.status).toBe(400);
    expect(await inf.json()).toEqual({ ok: false, error: "bad_credits" });
    for (const addCredits of ["30", 100_001, -100_001, true]) expect((await call(u.email, { addCredits })).status, String(addCredits)).toBe(400);
    expect((await getUser(u.email))!.credits).toBe(before);
    expect((await call(u.email, { addCredits: 30.7 })).status).toBe(200);
    expect((await getUser(u.email))!.credits).toBe(before + 30);
    expect(Number.isFinite((await getUser(u.email))!.credits)).toBe(true);
  });
});
