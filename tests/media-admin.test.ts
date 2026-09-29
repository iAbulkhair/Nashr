import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { MEDIA_ENV, mediaEnv, noNetwork, resetMediaCounters } from "./helpers/media";

const blob = vi.hoisted(() => ({
  put: vi.fn<(pathname: string, body: unknown, opts: Record<string, unknown>) => Promise<{ url: string }>>(),
  del: vi.fn<(url: string, opts: Record<string, unknown>) => Promise<void>>(),
}));
vi.mock("@vercel/blob", () => blob);

import * as media from "@/app/api/admin/media/route";
import { createUser, saveUser, type User } from "@/lib/auth";
import { db, pushCapped } from "@/lib/db";
import { monthKey } from "@/lib/credits";
import { mk } from "@/lib/media/keys";
import { higgsfieldAdapter } from "@/lib/media/higgsfield";
import { overview, renderSpend } from "@/lib/admin-stats";
import { kpis, statsText } from "@/lib/stats";
import { TASK_COST, TASK_COUNT, saveTask, type Task } from "@/lib/brand";
import { appDict } from "@/lib/app-i18n";

/**
 * The founder console's media side (spec A15, 4.9): GET /api/admin/media runs only for the founder, reports flags and
 * check results but never a variable's value, and the render spend counters reach the overview, the gross margin and the
 * owner's own reports.
 */
const FOUNDER = "founder-media@test.example";
const STORE = "https://s1.public.blob.vercel-storage.com/";
let customer: User;
let net: ReturnType<typeof noNetwork>;

type Call = { url: URL; init: RequestInit };
let calls: Call[] = [];
/** A recording fetch: kie answers the balance, Higgsfield answers every /estimate with a price except Hailuo (422). */
function providers() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const reply = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    if (url.host === "api.kie.ai" && url.pathname === "/api/v1/chat/credit") return reply({ code: 200, msg: "success", data: 1234.5 });
    if (url.host === "api.higgsfield.ai" && url.pathname.startsWith("/estimate/")) return url.pathname.includes("hailuo") ? reply({ detail: "bad" }, 422) : reply({ usd: "0.094" });
    throw new Error(`unexpected fetch: ${url.host}`);
  }) as typeof fetch;
}
const get = async () => {
  const res = await media.GET(json("/api/admin/media", "GET"));
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  customer = await newUser("mediaadm");
  await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" });
});
beforeEach(() => {
  calls = [];
  resetMediaCounters();
  blob.put.mockReset().mockImplementation(async (pathname) => ({ url: STORE + pathname }));
  blob.del.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  vi.stubEnv("WAITLIST_ADMIN_KEY", "");
  vi.stubEnv("APP_ORIGIN", "");
  mediaEnv({});
  net = noNetwork();
});
afterEach(() => {
  net.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/admin/media: who may call it", () => {
  it("refuses an anonymous caller and a signed-in customer, and calls no provider", async () => {
    signOut();
    expect((await get()).status).toBe(401);
    await signIn(customer.email);
    expect((await get()).status).toBe(401);
    expect(net.hosts).toEqual([]);
    expect(blob.put).not.toHaveBeenCalled();
  });

  it("answers the founder with the configuration flags; nothing configured means no request anywhere", async () => {
    await signIn(FOUNDER);
    const { status, text } = await get();
    expect(status).toBe(200);
    const j = JSON.parse(text);
    expect(j.configured).toEqual({ fal: false, kie: false, higgsfield: false, blob: false, webhooks: false });
    expect(j.modelsOn).toEqual(["img-fast"]);
    expect(j.available).toEqual([]);
    expect(j).toMatchObject({ blob: "error:no_blob", kie: null, higgsfield: null, open: { fal: 0, kie: 0, higgsfield: 0 }, off: {}, recent: [] });
    expect(net.hosts).toEqual([]);
    expect(blob.put).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/media: the provider check", () => {
  it("reports the kie balance, each Higgsfield estimate, the Blob probe and the models switched on, and no variable value", async () => {
    mediaEnv({ fal: true, kie: true, hmac: true, higgsfield: true, blob: true, models: "img-balanced" });
    vi.stubEnv("APP_ORIGIN", "https://app.example.com");
    providers();
    await signIn(FOUNDER);
    const { status, text } = await get();
    expect(status).toBe(200);
    const j = JSON.parse(text);
    expect(j.configured).toEqual({ fal: true, kie: true, higgsfield: true, blob: true, webhooks: true });
    expect(j.modelsOn).toEqual(["img-fast", "img-balanced"]);
    expect(j.available).toEqual(["img-fast", "img-balanced"]);
    expect(j.blob).toBe("ok");
    expect(j.kie).toEqual({ balanceCredits: 1234.5 });
    expect(j.higgsfield).toEqual({ "img-lifestyle": 0.094, "img-design": 0.094, "vid-cinematic": 0.094, "vid-motion": "error:422", "vid-cinematic:text": 0.094 });
    // The probe wrote one tiny file and deleted it again.
    expect(blob.put).toHaveBeenCalledTimes(1);
    expect(blob.del).toHaveBeenCalledWith(STORE + blob.put.mock.calls[0][0], expect.anything());
    // Only the two fixed provider hosts, and the keys travelled in headers, not in a URL.
    expect(new Set(calls.map((c) => c.url.host))).toEqual(new Set(["api.kie.ai", "api.higgsfield.ai"]));
    const values = Object.values(MEDIA_ENV).flat().map((n) => `test-${n.toLowerCase()}`);
    for (const v of values) {
      expect(text, `the answer carries the value of a variable`).not.toContain(v);
      expect(calls.map((c) => c.url.href).join(" ")).not.toContain(v);
    }
  });

  it("names a Blob store that refuses the write, and an adapter check that throws, with fixed codes", async () => {
    mediaEnv({ kie: true, higgsfield: true, blob: true });
    providers();
    blob.put.mockRejectedValueOnce(new Error("BlobAccessError: token rejected for store xyz"));
    vi.spyOn(higgsfieldAdapter, "check").mockRejectedValueOnce(new Error("socket hang up at 10.0.0.1"));
    await signIn(FOUNDER);
    const { text } = await get();
    const j = JSON.parse(text);
    expect(j.blob).toBe("error:put_failed");
    expect(j.higgsfield).toEqual({ error: "unreachable" });
    expect(j.kie).toEqual({ balanceCredits: 1234.5 });
    expect(j.configured.webhooks).toBe(false);
    expect(text).not.toContain("token rejected");
    expect(text).not.toContain("10.0.0.1");
  });

  it("lists the switched-off models (not the expired ones), the open jobs and the last renders without any account data", async () => {
    mediaEnv({ kie: true, blob: true, models: "img-balanced,vid-quick" });
    providers();
    const until = Date.now() + 3600_000;
    await db.set(mk.off(), { "vid-quick": { until, reason: "timeout" }, "img-balanced": { until: Date.now() - 1000, reason: "old" } });
    await Promise.all([db.sadd(mk.open("kie"), "a@test.example|" + "1".repeat(32)), db.sadd(mk.open("kie"), "b@test.example|" + "2".repeat(32))]);
    const done = { id: "a".repeat(32), model: "img-balanced", state: "done", providerCredits: 8, costUsd: 0.04, at: new Date().toISOString() };
    const failed = { id: "b".repeat(32), model: "vid-quick", state: "failed", error: "timeout", at: new Date().toISOString(), email: "someone@test.example", scope: "someone@test.example" };
    await pushCapped(mk.recent(), JSON.stringify(done), 50);
    await pushCapped(mk.recent(), "not json", 50);
    await pushCapped(mk.recent(), JSON.stringify(failed), 50);
    await signIn(FOUNDER);
    const { text } = await get();
    const j = JSON.parse(text);
    expect(j.off).toEqual({ "vid-quick": { until, reason: "timeout" } });
    expect(j.available, "a model the breaker switched off is not offered").toEqual(["img-balanced"]);
    expect(j.open).toEqual({ fal: 0, kie: 2, higgsfield: 0 });
    expect(j.recent).toEqual([{ id: failed.id, model: "vid-quick", state: "failed", error: "timeout", at: failed.at }, done]);
    expect(text).not.toContain("someone@test.example");
  });
});

describe("render spend in the founder overview", () => {
  const writeSpend = async () => {
    const k = mk.spend(monthKey());
    const old = mk.spend("2020-01");
    await Promise.all([
      db.incrby(`${k}:m:vid-quick:jobs`, 3), db.incrby(`${k}:m:vid-quick:failed`, 1), db.incrby(`${k}:m:vid-quick:credits`, 36), db.incrby(`${k}:m:vid-quick:usd_micro`, 630_000),
      db.incrby(`${k}:m:img-balanced:jobs`, 2), db.incrby(`${k}:m:img-balanced:credits`, 2), db.incrby(`${k}:m:img-balanced:usd_micro`, 80_000),
      db.incrby(`${k}:m:img-fast:jobs`, 5), db.incrby(`${k}:m:img-fast:credits`, 5), db.incrby(`${k}:m:img-fast:usd_micro`, 15_000),
      // Two copies that failed after Higgsfield billed us: failed, no credits kept, cost recorded.
      db.incrby(`${k}:m:vid-cinematic:failed`, 2), db.incrby(`${k}:m:vid-cinematic:usd_micro`, 12_345_678),
      db.incrby(`${k}:kie_centicredits`, 4250),
      db.incrby(`${old}:m:vid-quick:usd_micro`, 99_000_000), db.incrby(`${old}:m:vid-quick:jobs`, 7),
    ]);
  };

  it("renderSpend sums the per-model counters of the month into provider and month totals", async () => {
    await writeSpend();
    const s = await renderSpend();
    expect(s.usd).toBe(13.070678);
    expect(s.kieCredits).toBe(42.5);
    expect(s.byModel["vid-quick"]).toEqual({ jobs: 3, failed: 1, credits: 36, usd: 0.63 });
    expect(s.byModel["vid-cinematic"]).toEqual({ jobs: 0, failed: 2, credits: 0, usd: 12.345678 });
    expect(s.byModel["img-premium"]).toEqual({ jobs: 0, failed: 0, credits: 0, usd: 0 });
    expect(s.byProvider).toEqual({ fal: { usd: 0.015, jobs: 5, failed: 0 }, kie: { usd: 0.71, jobs: 5, failed: 1 }, higgsfield: { usd: 12.345678, jobs: 0, failed: 2 } });
    expect((await renderSpend("2020-01")).byModel["vid-quick"]).toEqual({ jobs: 7, failed: 0, credits: 0, usd: 99 });
  });

  it("overview reports the render cost and the per-model breakdown, and the gross margin subtracts it", async () => {
    const payer = await newUser("mediapay");
    await saveUser({ ...payer, plan: "pro" });
    await writeSpend();
    const o = await overview();
    expect(o.revenue.renderCostUsd).toBe(13.070678);
    expect(o.revenue.renderByModel["vid-quick"]).toMatchObject({ jobs: 3, failed: 1, credits: 36 });
    expect(o.revenue.renderByProvider.higgsfield.failed).toBe(2);
    const mrr = o.revenue.mrrSar;
    expect(mrr).toBeGreaterThan(0);
    const withRender = Math.round(((mrr - (o.revenue.modelCostUsd + o.revenue.renderCostUsd) * 3.75) / mrr) * 100);
    const withoutRender = Math.round(((mrr - o.revenue.modelCostUsd * 3.75) / mrr) * 100);
    expect(withRender).not.toBe(withoutRender);
    expect(o.revenue.grossMarginPct).toBe(withRender);
  });

  it("credits used this month count what renders kept (mediaCredits), not one credit per image", async () => {
    const u = await newUser("mediacred");
    const before = (await overview()).revenue.creditsUsedMonth;
    await saveTask(u.email, task("v", { mediaCredits: 24, videoUrl: `${STORE}media/v.mp4`, imageUrl: `${STORE}media/i.jpg`, imageProvider: "kie" }), true);
    const after = (await overview()).revenue.creditsUsedMonth;
    expect(after - before).toBe(Math.round(TASK_COST.social / TASK_COUNT.social + 24));
  });
});

let tn = 0;
const task = (id: string, over: Partial<Task> = {}): Task => ({ id: `${id}${++tn}`, type: "social", channel: "instagram", title: `t ${id}`, body: "b", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over });

describe("owner reports: videos and render credits", () => {
  it("kpis count mediaCredits and videos, fall back to one credit for a legacy image, and statsText names videos", async () => {
    const s = (await newUser("mediakpi")).email;
    await Promise.all([
      saveTask(s, task("video", { mediaCredits: 24, videoUrl: `${STORE}media/v.mp4`, imageUrl: `${STORE}media/i.jpg`, imageProvider: "kie" }), true),
      saveTask(s, task("legacy", { imageUrl: "https://v3.fal.media/files/x.jpg", imageProvider: "fal" }), true),
      saveTask(s, task("refunded", { mediaCredits: 0, imageUrl: "https://placehold.example/x.png", imageProvider: "placeholder" }), true),
      saveTask(s, task("plain"), true),
    ]);
    const k = await kpis(s, 7);
    const per = TASK_COST.social / TASK_COUNT.social;
    expect(k.creditsUsed).toBe(Math.round(4 * per + 24 + 1 + 0));
    expect(k.videos).toBe(1);
    // The placeholder card is not an image anyone generated: the kie image and the legacy fal image are.
    expect(k.images).toBe(2);
    const text = statsText(k);
    expect(text).toContain("images generated: 2");
    expect(text).toContain("videos generated: 1");
  });

  it("the reports page offers a videos tile, labelled in both languages", () => {
    const src = readFileSync("src/components/app/ReportsPanel.tsx", "utf8");
    const metrics = src.match(/const METRICS = \[([^\]]*)\]/)?.[1] ?? "";
    expect(metrics).toContain('"videos"');
    expect(src).toContain("videos: { label: R.videos, value: String(k.videos) }");
    expect(appDict.ar.reports.videos).toBeTruthy();
    expect(appDict.en.reports.videos).toBeTruthy();
  });
});
