import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The fair-use stop (rules 1720-1737, docs/system/flows.md section 73, docs/system/tests/1720-fair-use-stop.md). Founder
 * decision of 2026-10-13: "no need to lawyer, just stop the service". Every model call is counted here and none may
 * happen once an account is paused.
 */
const h = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: () => ({ finalMessage: async () => { h.calls += 1; throw new Error("no model call expected in this test"); } }),
      create: async () => { h.calls += 1; throw new Error("no model call expected in this test"); },
    };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { db } from "@/lib/db";
import { getUser, saveUser, sc, type Plan, type User } from "@/lib/auth";
import { monthKey } from "@/lib/credits";
import { SAR_PER_USD } from "@/lib/pricing";
import { chatMsgKey, mediaCostKey } from "@/lib/usage";
import { listNotifs } from "@/lib/notifications";
import { createMcpToken } from "@/lib/mcp";
import { appDict } from "@/lib/app-i18n";
import { LEGAL } from "@/lib/legal";
import { limitText } from "@/components/app/LimitModal";
import {
  FAIR_USE_ERROR, FAIR_USE_PCT, fairUseAlertText, fairUseAlertedKey, fairUseGate, fairUseLimitSar, fairUseOf, fairUseState,
  fairUseText, liftedFor, markFairUse, resumesOn,
} from "@/lib/fair-use";
import { generateBatch } from "@/lib/generate-batch";
import { renderImage, renderVideo } from "@/lib/media/start";
import { saveBrand, type Brand, type Task } from "@/lib/brand";
import type { MarginRow } from "@/lib/margin";
import { adminSignIn, jar, json, newUser, signIn, signOut } from "./helpers/session";
import * as chatRoute from "@/app/api/chat/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as fairUseRoute from "@/app/api/admin/fair-use/route";

const KEY = "fair-use-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
beforeEach(() => { h.calls = 0; vi.stubEnv("ANTHROPIC_API_KEY", "test"); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { signOut(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const src = (f: string) => readFileSync(f, "utf8");
async function account(plan: Plan, extra: Partial<User> = {}): Promise<User> {
  const u = await newUser("fu");
  const x = { ...(await getUser(u.email))!, plan, credits: 300, ...extra };
  await saveUser(x);
  return x;
}
/** Model and media cost for `email` in `month`, in USD, as the counters store them (micro-dollars). */
const spend = (email: string, month: string, modelUsd: number, mediaUsd = 0) =>
  Promise.all([db.set(`usage:${email}:${month}:usd_micro`, Math.round(modelUsd * 1e6)), db.set(mediaCostKey(email, month), Math.round(mediaUsd * 1e6))]);
/** A Starter account (299 SAR net) whose cost this month is past its limit. */
async function paused(extra: Partial<User> = {}): Promise<User> {
  const u = await account("starter", extra);
  await spend(u.email, monthKey(), 60, 30); // 90 USD × 3.75 = 337.5 SAR ≥ 284.05 (95% of 299)
  return u;
}

describe("the limit (rules 1720, 1721)", () => {
  it("is 95% of the plan's net price (founder, 2026-10-13); cost equal to the limit pauses, a halala under it does not", () => {
    expect(FAIR_USE_PCT).toBe(95);
    const u = { plan: "starter" as Plan, email: "x@test.example" };
    const month = "2031-05";
    expect(fairUseLimitSar(u, month)).toBe(284.05);
    expect(fairUseState(u, 284.05 / SAR_PER_USD, month)).toMatchObject({ applies: true, costSar: 284.05, limitSar: 284.05, paused: true });
    expect(fairUseState(u, 284.04 / SAR_PER_USD, month).paused).toBe(false);
    // just under 95% of the price still runs; at or over 95% is paused, and 100% is long past the line
    expect(fairUseState(u, (299 * 0.949) / SAR_PER_USD, month).paused).toBe(false);
    expect(fairUseState(u, (299 * 0.95) / SAR_PER_USD, month).paused).toBe(true);
    expect(fairUseState(u, 299 / SAR_PER_USD, month).paused).toBe(true);
    expect(fairUseState(u, 0, month).paused).toBe(false);
    expect(fairUseState(u, Number.NaN, month).paused).toBe(false);
    expect(fairUseLimitSar({ plan: "pro" }, month)).toBe(474.05);
  });
  it("the Agency deal's price is its revenue", () => {
    const u = { plan: "agency" as Plan, deal: { credits: 5000, priceSar: 3330, setAt: "2031-05-01T00:00:00.000Z", setBy: "f@test.example" } };
    expect(fairUseLimitSar(u, "2031-05")).toBe(3163.5);
  });
  it("the trial, a suspended account and a plan without a price are never paused (the trial keeps its own limits)", () => {
    for (const u of [{ plan: "trial" as Plan }, { plan: "starter" as Plan, suspended: true }]) {
      expect(fairUseState(u, 1e6, "2031-05")).toMatchObject({ applies: false, paused: false });
    }
  });
  it("a top-up pack paid this month raises the limit by what was paid, net of refunds; last month's pack does not", () => {
    const lot = (paidOn: string, paidSar: number, refund?: number) => ({ id: "a".repeat(16), credits: 100, left: 100, paidSar, paidOn, expiresAt: "2031-12-01T00:00:00.000Z", ...(refund ? { refund: { sar: refund, at: paidOn, by: "f@test.example" } } : {}) });
    const u = { plan: "starter" as Plan, topups: [lot("2031-05-03", 100), lot("2031-05-04", 50, 20), lot("2031-04-28", 999)] } as unknown as User;
    expect(fairUseLimitSar(u, "2031-05")).toBe(407.55); // (299 + 100 + 30) × 95%
    expect(fairUseState(u, 407.54 / SAR_PER_USD, "2031-05").paused).toBe(false);
    expect(fairUseState(u, 407.55 / SAR_PER_USD, "2031-05").paused).toBe(true);
  });
  it("the founder's lift counts for its month only", () => {
    const u = { plan: "starter" as Plan, fairUseLift: { month: "2031-05", at: "2031-05-10T00:00:00.000Z", by: "f@test.example" } };
    expect(liftedFor(u, "2031-05")).toBe(true);
    expect(fairUseState(u, 1e4, "2031-05")).toMatchObject({ lifted: true, paused: false });
    expect(fairUseState(u, 1e4, "2031-06")).toMatchObject({ lifted: false, paused: true });
  });
  it("a pause ends by itself on the 1st of the next month (UTC)", () => {
    expect(resumesOn("2031-05")).toBe("2031-06-01");
    expect(resumesOn("2031-12")).toBe("2032-01-01");
  });
});

describe("the reads (rules 1726, 1728)", () => {
  it("one MGET of the margin alert's two counters; nothing read for an account the stop does not apply to", async () => {
    const u = await account("starter");
    const month = "2031-07";
    await spend(u.email, month, 70, 10);
    const mget = vi.spyOn(db, "mget");
    const s = await fairUseOf(u, month);
    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget.mock.calls[0][0]).toEqual([`usage:${u.email}:${month}:usd_micro`, mediaCostKey(u.email, month)]);
    expect(s).toMatchObject({ costSar: 300, limitSar: 284.05, paused: true });
    mget.mockClear();
    const t = await account("trial");
    await spend(t.email, month, 1000);
    expect((await fairUseOf(t, month)).paused).toBe(false);
    expect(mget).not.toHaveBeenCalled();
  });
  it("a failed read lets the request through (logged), it never throws", async () => {
    const u = await paused();
    vi.spyOn(db, "mget").mockRejectedValueOnce(new Error("store down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fairUseGate(u)).toBeNull();
    expect(log).toHaveBeenCalledWith("fair_use_read_failed", { error: "Error" });
  });
});

describe("the stop, before any provider call (rules 1722-1725)", () => {
  it("POST /api/chat answers 402 fair_use, counts no message and calls no model", async () => {
    const u = await paused();
    await signIn(u.email);
    const r = await chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا" }));
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe(FAIR_USE_ERROR);
    expect(Number((await db.get<number>(chatMsgKey(u.email))) ?? 0)).toBe(0);
    expect(h.calls).toBe(0);
  });
  it("below the limit the same kind of account is not refused by the stop", async () => {
    const u = await account("starter");
    await spend(u.email, monthKey(), 10);
    expect(await fairUseGate(u)).toBeNull();
  });
  it("MCP ask_noor gets the fair-use sentence and no model call (rule 1732)", async () => {
    const u = await paused();
    const token = await createMcpToken(u.email);
    const res = await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_noor", arguments: { message: "hi" } } }) }));
    const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(j.result.content[0].text).toBe(fairUseText());
    expect(fairUseText()).toContain("fair-use limit");
    expect(h.calls).toBe(0);
  });
  it("generateBatch refuses with fair_use before the classifier, the charge and the model", async () => {
    const u = await paused();
    await saveBrand(u.email, { name: "Rose", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "coffee", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: new Date().toISOString() });
    const r = await generateBatch(u, sc(u), { type: "social", source: "manual", via: "app" });
    expect(r).toMatchObject({ ok: false, reason: "fair_use", resumes: resumesOn(monthKey()) });
    expect((await getUser(u.email))!.credits).toBe(300);
    expect(h.calls).toBe(0);
  });
  it("image and video renders refuse 402 fair_use, the free placeholder card included", async () => {
    const u = await paused();
    const t = { id: "t1", type: "post", channel: "instagram" } as unknown as Task;
    const opts = { deadline: Date.now() + 60_000 };
    expect(await renderImage(u, t, {} as Brand, undefined, opts)).toMatchObject({ ok: false, status: 402, error: "fair_use" });
    expect(await renderVideo(u, t, {} as Brand, "x", opts)).toMatchObject({ ok: false, status: 402, error: "fair_use" });
  });
  it("the trial is not gated twice: a trial account past any cost is not refused by the stop", async () => {
    const u = await account("trial");
    await spend(u.email, monthKey(), 5000);
    expect(await fairUseGate(u)).toBeNull();
  });
});

describe("the founder (rules 1729-1731, 1733)", () => {
  it("one bell item per account per month, plan only, linking to the margin section", async () => {
    const founder = await newUser("fuf");
    vi.stubEnv("ADMIN_EMAILS", founder.email);
    const u = await paused();
    const month = monthKey();
    expect(await fairUseGate(u, month)).toMatchObject({ error: "fair_use", month });
    expect(await fairUseGate(u, month)).not.toBeNull();
    const items = (await listNotifs(founder.email)).filter((n) => n.href.endsWith("/admin/usage#margin"));
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).not.toContain(u.email);
    expect(await db.get(fairUseAlertedKey(month, u.email))).toBeTruthy();
    expect(fairUseAlertedKey(month, u.email)).not.toContain(u.email);
    for (const lang of ["ar", "en"] as const) expect(fairUseAlertText("starter", lang).title.length).toBeGreaterThan(0);
    expect(fairUseAlertText("starter", "en").body).toContain("95% of what it paid");
    expect(fairUseAlertText("starter", "ar").body).toContain("95%");
  });
  it("POST /api/admin/fair-use: founder only, a reason, a known action; lift and clear are audited and month-scoped", async () => {
    const u = await paused();
    const call = (body: Record<string, unknown>) => fairUseRoute.POST(json("/api/admin/fair-use", "POST", body));
    expect((await call({ email: u.email, action: "lift", reason: "goodwill" })).status).toBe(401);
    await signIn(u.email);
    expect((await call({ email: u.email, action: "lift", reason: "goodwill" })).status).toBe(401);
    jar().clear();
    await adminSignIn();
    expect((await call({ email: u.email, action: "lift" })).status).toBe(400);
    expect((await (await call({ email: u.email, action: "pause", reason: "goodwill" })).json()).error).toBe("bad_action");
    expect((await call({ email: "", action: "lift", reason: "goodwill" })).status).toBe(400);
    expect((await call({ email: "nobody-fair-use@test.example", action: "lift", reason: "goodwill" })).status).toBe(404);

    const lift = await call({ email: u.email, action: "lift", reason: "goodwill" });
    expect(lift.status).toBe(200);
    expect(lift.headers.get("cache-control")).toBe("no-store");
    expect((await lift.json()).fairUse).toMatchObject({ email: u.email, month: monthKey(), lifted: true, paused: false });
    const after = (await getUser(u.email))!;
    expect(after.fairUseLift?.month).toBe(monthKey());
    expect(await fairUseGate(after)).toBeNull();
    const row = JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { action: string; target: string; reason: string };
    expect(row).toMatchObject({ action: "fair_use_lift", target: u.email, reason: "goodwill" });

    expect((await call({ email: u.email, action: "clear", reason: "back to normal" })).status).toBe(200);
    const cleared = (await getUser(u.email))!;
    expect(cleared.fairUseLift).toBeUndefined();
    expect(await fairUseGate(cleared)).not.toBeNull();
    expect(JSON.parse((await db.lrange("admin:log", 0, 0))[0]).action).toBe("fair_use_clear");
  });
  it("the write is behind the second factor, right after the founder check", () => {
    const s = src("src/app/api/admin/fair-use/route.ts");
    const order = ["adminActor(req)", "secondFactorRefusal(req, who)", "reasonRefused(b.reason)", "withUserLock(acct(account)", "adminAudit("];
    const at = order.map((x) => s.indexOf(x));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it("the console marks paused and lifted rows", () => {
    const row = (email: string, modelUsd: number): MarginRow => ({ email, name: "", plan: "starter", revenueSar: 299, modelUsd, mediaUsd: 0, costSar: modelUsd * SAR_PER_USD, marginPct: 0 });
    const users = [
      { email: "a@test.example", plan: "starter" },
      { email: "b@test.example", plan: "starter", fairUseLift: { month: "2031-05", at: "", by: "f" } },
      { email: "c@test.example", plan: "starter" },
    ] as User[];
    const out = markFairUse([row("a@test.example", 100), row("b@test.example", 100), row("c@test.example", 10)], users, "2031-05");
    expect(out.map((r) => r.fairUse)).toEqual(["paused", "lifted", null]);
  });
});

describe("the owner's message (rule 1727)", () => {
  it("Arabic and English: the owner is told when it resumes and about top-up packs, a member to ask the owner", () => {
    for (const lang of ["ar", "en"] as const) {
      const L = appDict[lang].limit;
      const [title, body] = limitText(L, { kind: "fair_use" }, true);
      const [, member] = limitText(L, { kind: "fair_use" }, false);
      expect(title).toBe(L.fairUseTitle);
      expect(body).toBe(L.fairUseBody);
      expect(member).toBe(L.askOwnerFairUse);
      expect(appDict[lang].activity.outcomes.fair_use).toBeTruthy();
    }
    expect(appDict.en.limit.fairUseTitle).toBe("Usage paused until next month");
    expect(appDict.en.limit.fairUseBody).toContain("top-up pack");
    expect(appDict.ar.limit.fairUseBody).toContain("باقة شحن");
  });
  it("the modal offers the top-up pack and every panel maps the code", () => {
    expect(src("src/components/app/LimitModal.tsx")).toMatch(/kind === "fair_use"\) && topups/);
    for (const f of ["src/components/app/GeneratePanel.tsx", "src/components/app/ReportsPanel.tsx", "src/components/app/StartLaunch.tsx", "src/components/app/MediaControls.tsx", "src/components/app/ChatPanel.tsx"]) {
      expect(src(f), f).toContain("fair_use");
    }
  });
});

describe("every paid path is gated (rule 1734) and the terms say so (rule 1736)", () => {
  it("each file that charges credits or reserves a chat turn calls the gate, or is a named exception", () => {
    const gated: Record<string, string> = {
      "src/lib/chat-allowance.ts": "fairUseGate(u)",
      "src/lib/generate-batch.ts": "fairUseGate(user)",
      "src/lib/media/start.ts": "fairUseGate(u)",
      "src/app/api/onboard/route.ts": "fairUseGate(u)",
      "src/app/api/onboard/confirm/route.ts": "fairUseGate(u)",
      "src/app/api/instructions/test/route.ts": "fairUseGate(u)",
      "src/lib/secretary-meeting.ts": "fairUseGate(user)",
    };
    for (const [f, call] of Object.entries(gated)) expect(src(f), f).toContain(call);
    // x-stats.ts charges for X API reads, not model or media cost (rule 1737); jobs.ts is reached only through start.ts.
    expect(src("src/lib/x-stats.ts")).not.toContain("fairUseGate");
    // The gate sits before the charge in each file that charges.
    for (const f of ["src/lib/generate-batch.ts", "src/app/api/instructions/test/route.ts", "src/app/api/onboard/route.ts", "src/lib/secretary-meeting.ts"]) {
      const s = src(f);
      const charge = s.search(/\b(charge|chargeOnce|chargeOnboard)\(/);
      expect(charge, f).toBeGreaterThan(0);
      expect(s.indexOf("fairUseGate("), f).toBeLessThan(charge);
    }
  });
  it("the terms carry one fair-use sentence in both languages, and the date moved", () => {
    const sub = (lang: "ar" | "en") => LEGAL[lang].terms.sections.find((x) => x.h === (lang === "ar" ? "الاشتراك والكريدت" : "Subscription and credits"))!.p.join(" ");
    expect(sub("en")).toContain("Usage may pause when an account's monthly usage exceeds its plan's fair-use limit.");
    expect(sub("ar")).toContain("حد الاستخدام العادل");
    expect(LEGAL.en.terms.updated).toBe("Last updated: 2026-10-13");
  });
  it("the system docs say the same", () => {
    expect(src("docs/system/flows.md")).toContain("## 73. Fair-use stop");
    expect(src("docs/system/permissions.md")).toContain("`/api/admin/fair-use`");
    expect(src("docs/system/architecture.md")).toContain("`fair-use.ts`");
    expect(src("docs/system/tests/1720-fair-use-stop.md")).toMatch(/\| 1737 \|/);
  });
});
