import { beforeAll, describe, expect, it, vi } from "vitest";
import { jar, json, newUser, params, settle, signIn, signOut } from "./helpers/session";
import { createUser, currentUser, getUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";

import * as overview from "@/app/api/admin/overview/route";
import * as plan from "@/app/api/admin/plan/route";
import * as users from "@/app/api/admin/users/[email]/route";
import * as exportRoute from "@/app/api/admin/export/route";
import * as log from "@/app/api/admin/log/route";
import * as evals from "@/app/api/admin/evals/route";
import * as golden from "@/app/api/admin/golden/route";
import * as impersonate from "@/app/api/admin/impersonate/route";
import * as wishlist from "@/app/api/admin/wishlist/route";
import * as cronDaily from "@/app/api/cron/daily/route";
import * as cronWeekly from "@/app/api/cron/weekly/route";
import * as cronGolden from "@/app/api/cron/golden/route";
import * as cronRoutines from "@/app/api/cron/routines/route";

const KEY = "test-admin-key-0123456789";
let customer: User, founder: User;

/** Every founder-console handler, called the way the console calls it. None of them may run for a non-founder. */
const adminCalls = (headers: Record<string, string> = {}, query = ""): (() => Promise<Response>)[] => {
  const who = params({ email: encodeURIComponent(customer.email) });
  return [
    () => overview.GET(json(`/api/admin/overview${query}`, "GET", undefined, headers)),
    () => plan.GET(json(`/api/admin/plan${query}`, "GET", undefined, headers)),
    () => plan.POST(json(`/api/admin/plan${query}`, "POST", { email: customer.email, addCredits: 1000 }, headers)),
    () => users.GET(json(`/api/admin/users/x${query}`, "GET", undefined, headers), who),
    () => users.POST(json(`/api/admin/users/x${query}`, "POST", { action: "suspend" }, headers), who),
    () => exportRoute.GET(json(`/api/admin/export${query}`, "GET", undefined, headers)),
    () => log.GET(json(`/api/admin/log${query}`, "GET", undefined, headers)),
    () => evals.GET(json(`/api/admin/evals${query}`, "GET", undefined, headers)),
    () => golden.GET(json(`/api/admin/golden${query}`, "GET", undefined, headers)),
    () => golden.POST(json(`/api/admin/golden${query}`, "POST", {}, headers)),
    () => wishlist.GET(json(`/api/admin/wishlist${query}`, "GET", undefined, headers)),
    () => wishlist.POST(json(`/api/admin/wishlist${query}`, "POST", { action: "promote", title: { ar: "عنوان", en: "Title" } }, headers)),
  ];
};
const statuses = async (calls: (() => Promise<Response>)[]) => { const out: number[] = []; for (const c of calls) out.push((await c()).status); return out; };

beforeAll(async () => {
  vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  vi.stubEnv("ADMIN_EMAILS", "founder@test.example");
  customer = await newUser("customer");
  founder = await createUser({ email: "founder@test.example", name: "Founder", phone: "", password: "abc12345", lang: "ar" });
});

describe("founder console routes (rule 6)", () => {
  it("refuse an anonymous caller", async () => {
    signOut();
    const s = await statuses(adminCalls());
    expect(s).toEqual(s.map(() => 401));
  });
  it("refuse a signed-in customer, and nothing they asked for happened", async () => {
    await signIn(customer.email);
    const s = await statuses(adminCalls());
    expect(s).toEqual(s.map(() => 401));
    const u = await getUser(customer.email);
    expect(u!.credits).toBe(50);
    expect(u!.suspended).toBeFalsy();
  });
  it("refuse the admin key in the URL and a wrong key in the header", async () => {
    signOut();
    expect(new Set(await statuses(adminCalls({}, `?key=${KEY}`)))).toEqual(new Set([401]));
    expect(new Set(await statuses(adminCalls({ "x-admin-key": KEY.slice(0, -1) + "x" })))).toEqual(new Set([401]));
  });
  it("accept the key in the x-admin-key header, and a founder session", async () => {
    signOut();
    expect((await overview.GET(json("/api/admin/overview", "GET", undefined, { "x-admin-key": KEY }))).status).toBe(200);
    await signIn(founder.email);
    expect((await log.GET(json("/api/admin/log", "GET"))).status).toBe(200);
  });
});

describe("impersonation (rule 12)", () => {
  it("lasts two hours, and returning burns the temporary session and restores the founder's", async () => {
    const mine = await signIn(founder.email);
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", reason: "test" }), params({ email: encodeURIComponent(customer.email) }));
    expect(res.status).toBe(200);
    const temp = jar().get("nashr_session")!;
    expect(temp).not.toBe(mine);
    expect(jar().get("nashr_return")).toBe(mine);
    expect((await currentUser())!.email).toBe(customer.email);

    // The temporary session dies on its own after two hours.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3600e3 + 1000);
    expect(await db.get(`session:${temp}`)).toBeNull();
    vi.useRealTimers();

    // A fresh impersonation, then the founder returns.
    jar().clear(); jar().set("nashr_session", mine);
    await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate" }), params({ email: encodeURIComponent(customer.email) }));
    const temp2 = jar().get("nashr_session")!;
    const form = new FormData(); form.set("lang", "ar");
    const back = await impersonate.POST(new Request("https://nashr.test/api/admin/impersonate", { method: "POST", body: form }));
    expect(back.status).toBe(303);
    expect(await db.get(`session:${temp2}`)).toBeNull();
    expect(jar().get("nashr_session")).toBe(mine);
    expect(jar().has("nashr_return")).toBe(false);
    expect(jar().has("nashr_impersonate")).toBe(false);
    expect((await currentUser())!.email).toBe(founder.email);
  });
});

describe("cron routes (rule 7)", () => {
  const routes = [cronDaily, cronWeekly, cronGolden, cronRoutines];
  const call = (r: { GET: (req: Request) => Promise<Response> }, auth?: string) => r.GET(new Request("https://nashr.test/api/cron/x", { headers: auth ? { authorization: auth } : {} }));
  it("answer 401 without the exact bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    for (const r of routes) {
      expect((await call(r)).status).toBe(401);
      expect((await call(r, "Bearer cron-secret-abcdeX")).status).toBe(401);
      expect((await call(r, "Bearer ")).status).toBe(401);
      expect((await call(r, "cron-secret-abcdef-extra")).status).toBe(401);
    }
  });
  it("answer 401 to everyone when the secret is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    for (const r of routes) { expect((await call(r, "Bearer ")).status).toBe(401); expect((await call(r, "Bearer undefined")).status).toBe(401); }
  });
  it("run with the right secret (daily, which calls no model)", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    expect((await call(cronDaily, "Bearer cron-secret-abcdef")).status).toBe(200);
  });
  it("the daily run's weekly catch-up kick (Sunday to Tuesday) forwards the cron bearer (rule 379)", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    const sent: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: RequestInit) => { sent.push({ url: String(u), auth: new Headers(init?.headers).get("authorization") }); return new Response("{}"); }));
    // A Monday (2026-10-05), only the clock faked: timers still run.
    vi.useFakeTimers({ now: new Date("2026-10-05T03:00:00.000Z"), toFake: ["Date"] });
    try {
      expect((await call(cronDaily, "Bearer cron-secret-abcdef")).status).toBe(200);
      await settle();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
    const kick = sent.filter((x) => new URL(x.url).pathname === "/api/cron/weekly");
    expect(kick, "Monday kicks the weekly route once").toHaveLength(1);
    expect(kick[0].auth, "without the bearer the weekly route answers 401 and the catch-up serves nobody").toBe("Bearer cron-secret-abcdef");
  });
});
