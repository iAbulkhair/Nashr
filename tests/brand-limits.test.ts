import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSignIn, jar, json, newUser, signIn, signOut } from "./helpers/session";
import { getUser, saveUser, type Plan, type User } from "@/lib/auth";
import { addBrand, activeCount, brandLimitRefusal, listBrands } from "@/lib/brands";
import { db } from "@/lib/db";
import { AGENCY_BRANDS, MAX_BRAND_CAP, PLAN_BRANDS, brandCapFor, isBrandCap } from "@/lib/pricing";
import { ADMIN_INPUT_ERRORS, parseBrandCap } from "@/lib/admin-input";
import { brandsText, dict } from "@/lib/i18n";

import * as brandsRoute from "@/app/api/brands/route";
import * as brandCap from "@/app/api/admin/brand-cap/route";
import * as plan from "@/app/api/admin/plan/route";

/**
 * Active brands per plan (founder decision 2026-10-09, spec #303 Part B, rules 1390-1395). The cap is read in code inside
 * the brand list's lock (`tests/brand-guardrails.test.ts` pins the add, restore, rate order and race: rule 1391); this
 * file pins the table and the override (1390), what GET answers and the panel shows (1392), the founder's route (1393),
 * the copy (1394) and the docs (1395).
 */
const KEY = "brand-cap-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });

async function account(p: Plan, extra: Partial<User> = {}): Promise<User> {
  const u = await newUser("bl");
  const x = { ...(await getUser(u.email))!, plan: p, ...extra };
  await saveUser(x);
  return x;
}
const setCap = (body: Record<string, unknown>) => brandCap.POST(json("/api/admin/brand-cap", "POST", body));
const lastLog = async () => JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { action: string; target: string; what: string; before: { cap: number; override: number | null }; after: { cap: number; override: number | null }; reason: string };

describe("rule 1390: the plan table and the founder's override", () => {
  it("plans get 1/1/2/5 brands, Agency 10 until the founder sets its number, the retired enterprise value reads as Agency", () => {
    expect(PLAN_BRANDS).toEqual({ trial: 1, starter: 1, pro: 2, business: 5 });
    for (const p of ["trial", "starter", "pro", "business"] as const) expect(brandCapFor({ plan: p }), p).toBe(PLAN_BRANDS[p]);
    expect(brandCapFor({ plan: "agency" })).toBe(AGENCY_BRANDS);
    expect(brandCapFor({ plan: "enterprise" as Plan })).toBe(AGENCY_BRANDS);
  });
  it("a valid override wins on any plan; out of range, fractional or non-number values are ignored", () => {
    expect(brandCapFor({ plan: "starter", brandCap: 3 })).toBe(3);
    expect(brandCapFor({ plan: "agency", brandCap: 40 })).toBe(40);
    expect(brandCapFor({ plan: "business", brandCap: 1 })).toBe(1);
    for (const bad of [0, -1, 1.5, MAX_BRAND_CAP + 1, Number.NaN, Infinity, "3" as unknown as number]) {
      expect(isBrandCap(bad), String(bad)).toBe(false);
      expect(brandCapFor({ plan: "pro", brandCap: bad }), String(bad)).toBe(PLAN_BRANDS.pro);
    }
    expect(isBrandCap(1) && isBrandCap(MAX_BRAND_CAP)).toBe(true);
  });
  it("only active brands count, so a list above the cap refuses and one archive below it allows", async () => {
    const u = await account("pro");
    expect(await addBrand(u, "Second")).toMatchObject({ status: "active" });
    const rows = await listBrands(u.email);
    expect(activeCount(rows)).toBe(2);
    expect(brandLimitRefusal(u, rows)).toEqual({ error: "brand_limit", cap: 2, count: 2 });
    expect(brandLimitRefusal(u, rows.map((b) => (b.id === "default" ? b : { ...b, status: "archived" as const })))).toBeNull();
    // addBrand itself refuses at the cap and writes nothing.
    expect(await addBrand(u, "Third")).toEqual({ error: "brand_limit", cap: 2, count: 2 });
    expect(await listBrands(u.email)).toHaveLength(2);
  });
});

describe("rule 1392: GET answers the cap, the count and who may upgrade; the panel shows them", () => {
  beforeEach(() => signOut());
  it("GET /api/brands carries cap, count and canUpgrade for the owner", async () => {
    const u = await account("business");
    await signIn(u.email);
    const j = await (await brandsRoute.GET()).json();
    expect(j).toMatchObject({ ok: true, cap: PLAN_BRANDS.business, count: 1, canUpgrade: true });
  });
  // The rendered note (both languages) is pinned in tests/pricing-copy.test.ts, which mocks the app router.
  it("the panel's source swaps the add form for the plan message when full and names brand_limit", () => {
    const src = readFileSync("src/components/app/BrandsPanel.tsx", "utf8");
    expect(src).toMatch(/const full = cap > 0 && activeCount >= cap;/);
    expect(src).toMatch(/\{manage && !full && \(\s*<form/);
    expect(src).toContain("/app/settings/billing");
    expect(src).toContain('j.error === "brand_limit"');
  });
});

describe("rule 1393: the founder sets an account's number (POST /api/admin/brand-cap)", () => {
  beforeEach(async () => { jar().clear(); });
  it("refuses without the founder, without a reason, with a bad number or a missing account, and writes nothing", async () => {
    const u = await account("agency");
    expect((await setCap({ email: u.email, brandCap: 20, reason: "contract" })).status).toBe(401);
    await signIn(u.email);
    expect((await setCap({ email: u.email, brandCap: 20, reason: "contract" })).status).toBe(401);
    jar().clear();
    await adminSignIn();
    expect((await setCap({ email: u.email, brandCap: 20 })).status).toBe(400);
    expect((await setCap({ email: u.email, brandCap: 20, reason: "x" })).status).toBe(400);
    for (const bad of [-1, 1.5, MAX_BRAND_CAP + 1, "20", true, {}]) {
      const r = await setCap({ email: u.email, brandCap: bad, reason: "contract" });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await r.json()).error).toBe("bad_brand_cap");
    }
    expect((await setCap({ email: "", brandCap: 20, reason: "contract" })).status).toBe(400);
    const missing = await setCap({ email: "nobody-brand-cap@test.example", brandCap: 20, reason: "contract" });
    expect(missing.status).toBe(404);
    expect((await getUser(u.email))!.brandCap).toBeUndefined();
  });
  it("sets and clears the number under the lock, logs before and after with the reason, and archives nothing", async () => {
    const u = await account("agency", { brandCap: 3 });
    await addBrand(u, "B2");
    await addBrand(u, "B3");
    await adminSignIn();
    const r = await setCap({ email: u.email, brandCap: 1, reason: "contract lowered" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, user: { email: u.email, brandCap: 1, brandCapOverride: 1, activeBrands: 3 } });
    expect((await getUser(u.email))!.brandCap).toBe(1);
    // Lowered below the active brands: every brand is still active, only new adds stop.
    expect(activeCount(await listBrands(u.email))).toBe(3);
    expect(await addBrand((await getUser(u.email))!, "B4")).toMatchObject({ error: "brand_limit", cap: 1, count: 3 });
    const log = await lastLog();
    expect(log).toMatchObject({ action: "brand_cap", target: u.email, before: { cap: 3, override: 3 }, after: { cap: 1, override: 1 }, reason: "contract lowered" });
    expect(log.what).toBe(`brand_cap ${u.email} 3→1`);
    // 0 and null go back to the plan's number.
    for (const clear of [0, null]) {
      const c = await setCap({ email: u.email, brandCap: clear, reason: "back to plan" });
      expect((await c.json()).user).toMatchObject({ brandCap: AGENCY_BRANDS, brandCapOverride: null });
      expect("brandCap" in (await getUser(u.email))!).toBe(false);
    }
  });
  it("the console's plan rows show the number and the override", async () => {
    const u = await account("pro", { brandCap: 4 });
    await adminSignIn();
    const rows = (await (await plan.GET(json("/api/admin/plan", "GET"))).json()).users as { email: string; brandCap: number; brandCapOverride: number | null }[];
    expect(rows.find((x) => x.email === u.email)).toMatchObject({ brandCap: 4, brandCapOverride: 4 });
  });
  it("the console form reads 0 as the plan's number and refuses anything outside 1-200 in both languages", () => {
    expect(parseBrandCap("0")).toEqual({ ok: true, value: { brandCap: null } });
    expect(parseBrandCap("12")).toEqual({ ok: true, value: { brandCap: 12 } });
    for (const bad of ["", "-1", "1.5", "201", "abc"]) expect(parseBrandCap(bad), bad).toEqual({ ok: false, error: "bad_brand_cap" });
    expect(ADMIN_INPUT_ERRORS.en.bad_brand_cap).toBeTruthy();
    expect(ADMIN_INPUT_ERRORS.ar.bad_brand_cap).toBeTruthy();
  });
});

describe("rule 1394: no copy says brands are unlimited; the counts come from PLAN_BRANDS", () => {
  const SOURCES = ["src/lib/i18n.ts", "src/lib/pages-industry.ts", "src/lib/site.ts", "src/lib/chat.ts", "src/lib/changelog.ts", "src/components/app/BrandsPanel.tsx"];
  it("none of the copy sources promise unlimited brands", () => {
    for (const f of SOURCES) expect(readFileSync(f, "utf8"), f).not.toMatch(/unlimited brands|brands are unlimited|علامات (و\S+ )?بلا حد|العلامات بلا حد/i);
  });
  it("the plan cards name each plan's count, Agency by agreement", () => {
    const card = (lang: "ar" | "en", id: string) => dict[lang].pricing.plans.find((x) => x.id === id)!.features.join(" ");
    for (const lang of ["ar", "en"] as const) {
      for (const id of ["starter", "pro", "business"] as const) expect(card(lang, id), `${lang} ${id}`).toContain(brandsText(lang, PLAN_BRANDS[id]));
    }
    expect(card("en", "agency")).toContain("Brands set by agreement");
    expect(card("ar", "agency")).toContain("عدد العلامات حسب الاتفاق");
  });
  it("brandsText counts in Arabic and English", () => {
    expect([1, 2, 5, 11].map((n) => brandsText("ar", n))).toEqual(["علامة واحدة", "علامتان", "5 علامات", "11 علامة"]);
    expect([1, 2].map((n) => brandsText("en", n))).toEqual(["1 brand", "2 brands"]);
  });
});

describe("rule 1395: the system docs say the same", () => {
  it("permissions, flows and architecture name the cap and the founder's route", () => {
    const perms = readFileSync("docs/system/permissions.md", "utf8");
    expect(perms).toContain("/api/admin/brand-cap");
    expect(perms).toContain("402 `brand_limit`");
    expect(readFileSync("docs/system/flows.md", "utf8")).toContain("## 29. Brands: capped per plan, rate-limited, locked");
    expect(readFileSync("docs/system/architecture.md", "utf8")).toContain("`brandCap`");
    expect(readFileSync("docs/system/tests/1390-brand-limits.md", "utf8")).toMatch(/\| 1395 \|/);
  });
});
