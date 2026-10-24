import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSignIn, jar, json, newUser, params, signIn } from "./helpers/session";
import { acct, getUser, saveUser, seatLimit, type Plan, type User } from "@/lib/auth";
import { monthKey, renewIfDue } from "@/lib/credits";
import { db } from "@/lib/db";
import { saveTask, type Task } from "@/lib/brand";
import { AGENCY_MIN, CHAT_ALLOWANCE, MAX_CHAT_OVERRIDE, PLAN_CREDITS, PLAN_SEATS, chatAllowanceOf } from "@/lib/pricing";
import { chatCredKey, chatMsgKey, chatOverKey, chatTrialKey, meter } from "@/lib/usage";
import { reserveChatTurn } from "@/lib/chat-allowance";
import { DEFAULTS } from "@/lib/models/route";

import * as plan from "@/app/api/admin/plan/route";
import { defaultPaidThrough } from "@/lib/hand-plan";
import { ksaDay } from "@/lib/partner-rules";
import * as exportRoute from "@/app/api/admin/export/route";
import * as profileRoute from "@/app/api/profile/route";
import * as adminUser from "@/app/api/admin/users/[email]/route";

/**
 * The founder console's plan API with Agency deals (rules 243 and 244): a deal is validated in code against the
 * Business rate (src/lib/pricing.ts `parseDeal`), lives only on Agency, is cleared when the account leaves Agency, is
 * logged before and after, and is what renewal and a plan change grant (`allowanceOf`). addCredits is bounded.
 * Rule 316: the founder's chat override (`User.chatAllowance`, 0 included) is validated, logged and ends with a deal like
 * its seats, and the console's rows, detail and CSV show each account's chat messages (the raw count, which can pass an
 * allowance lowered mid-period), the messages continued on credits and the credits they were billed, and chat cost.
 */
const KEY = "deal-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
// The console's key session cookie, as the console page sends it. Not the x-admin-key header: that one is throttled per
// IP (30 guesses in 15 minutes), and every call in this file comes from the same test address.
beforeEach(async () => { jar().clear(); await adminSignIn(); });

const headers = {};
const call = (email: string, body: Record<string, unknown>) => plan.POST(json("/api/admin/plan", "POST", { email, ...body }, headers));
/** A body sent as raw text, for what JSON.stringify cannot write (1e999 parses to Infinity). */
const raw = (text: string) => plan.POST(new Request("https://nashr.test/api/admin/plan", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text }));
/** A paid plan set by hand without a day gets one month from today, named in the log (rule 1302). */
const PAID = ` paid_through:${defaultPaidThrough(ksaDay())}`;
const logLength = async () => (await db.lrange("admin:log", 0, -1)).length;
const lastLog = async () => JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { what: string; before: { deal: string; seats: number; chat: number }; after: { deal: string; credits: number; seats: number; chat: number }; actor: string; reason?: string };
async function account(p: Plan, prefix = "deal"): Promise<User> {
  const u = await newUser(prefix);
  const x = { ...(await getUser(acct(u)))!, plan: p };
  await saveUser(x);
  return x;
}

describe("an Agency deal is checked in code (rule 244)", () => {
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
    expect((await getUser(acct(u)))!.deal).toBeUndefined();
    expect(await logLength(), "a refused change is not logged as made").toBe(logged);
  });

  it("exactly the Business rate is accepted; a deal change alone keeps the balance and applies at renewal", async () => {
    const u = await account("agency");
    await saveUser({ ...(await getUser(acct(u)))!, credits: 1234 });
    const res = await call(u.email, { deal: { ...AGENCY_MIN, seats: 40, setBy: "someone else" }, reason: "signed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { deal: Record<string, unknown>; allowance: number; credits: number } };
    expect(body.user.deal).toMatchObject({ credits: 1500, priceSar: 999, setBy: "key" });
    expect(body.user.deal, "only credits and price are read from the body").not.toHaveProperty("seats");
    expect(body.user.allowance).toBe(1500);
    expect(body.user.credits).toBe(1234);

    expect((await call(u.email, { deal: { credits: 3003, priceSar: 2000 } })).status).toBe(200);
    const after = (await getUser(acct(u)))!;
    expect(after.deal).toMatchObject({ credits: 3003, priceSar: 2000 });
    expect(after.credits, "the balance waits for the renewal").toBe(1234);
    expect(await lastLog()).toMatchObject({ what: "deal:3003@2000", before: { deal: "1500@999" }, after: { deal: "3003@2000" }, actor: "key" });

    await saveUser({ ...after, renewedAt: "2020-01" });
    expect(await renewIfDue(acct(u))).toBe(true);
    expect((await getUser(acct(u)))!.credits, "renewal grants the deal's credits (rule 243)").toBe(3003);
  });

  it("plan agency with a deal grants the deal at once and starts the renewal cycle", async () => {
    const u = await account("trial");
    const res = await call(u.email, { plan: "agency", deal: { credits: 3000, priceSar: 1998 } });
    expect(res.status).toBe(200);
    const x = (await getUser(acct(u)))!;
    expect(x.plan).toBe("agency");
    expect(x.credits).toBe(3000);
    expect(x.renewedAt).toBe(monthKey());
    expect(await lastLog()).toMatchObject({ what: `plan:agency deal:3000@1998${PAID}`, before: { deal: "none" }, after: { deal: "3000@1998", credits: 3000 } });
  });

  it("a deal on any other plan is refused, and so is a plan change away from Agency that carries one", async () => {
    for (const p of ["trial", "starter", "pro", "business"] as const) {
      const u = await account(p);
      const res = await call(u.email, { deal: AGENCY_MIN });
      expect(res.status, p).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "deal_needs_agency" });
      expect((await getUser(acct(u)))!.deal).toBeUndefined();
    }
    const a = await account("agency");
    await call(a.email, { deal: { credits: 2000, priceSar: 1332 } });
    const res = await call(a.email, { plan: "business", deal: AGENCY_MIN });
    expect(res.status).toBe(400);
    const x = (await getUser(acct(a)))!;
    expect(x.plan, "a refused request writes nothing").toBe("agency");
    expect(x.deal).toMatchObject({ credits: 2000, priceSar: 1332 });
  });

  it("leaving Agency clears the deal and its seats and logs both; coming back starts from Business", async () => {
    const u = await account("agency");
    // The console's Deal prompt sends the deal's seats with it: they live in the seat override.
    await call(u.email, { deal: { credits: 3003, priceSar: 2000 }, seats: 20 });
    expect(seatLimit((await getUser(acct(u)))!)).toBe(20);
    expect((await call(u.email, { plan: "pro" })).status).toBe(200);
    const x = (await getUser(acct(u)))!;
    expect(x.deal).toBeUndefined();
    expect(x.credits).toBe(PLAN_CREDITS.pro);
    expect(x.seats, "the deal's seats went with the deal").toBeUndefined();
    expect(seatLimit(x), "Pro's seats, not the deal's 20").toBe(PLAN_SEATS.pro);
    expect(await lastLog()).toMatchObject({ what: `plan:pro deal:none seats:plan${PAID}`, before: { deal: "3003@2000", seats: 20 }, after: { deal: "none", seats: PLAN_SEATS.pro } });
    expect((await call(u.email, { plan: "agency" })).status).toBe(200);
    const back = (await getUser(acct(u)))!;
    expect(back.credits, "Agency without a deal is Business's allowance").toBe(PLAN_CREDITS.business);
    expect(seatLimit(back), "and Business's seats").toBe(PLAN_SEATS.business);
  });

  it("a plan change away from Agency that sets seats keeps the seats it sets", async () => {
    const u = await account("agency");
    await call(u.email, { deal: { credits: 3003, priceSar: 2000 }, seats: 20 });
    expect((await call(u.email, { plan: "business", seats: 9 })).status).toBe(200);
    expect(seatLimit((await getUser(acct(u)))!)).toBe(9);
    expect((await lastLog()).what).toBe(`plan:business deal:none seats:9${PAID}`);
  });

  it("deal null clears it and its seats, and the change is logged", async () => {
    const u = await account("agency");
    await call(u.email, { deal: { credits: 1500, priceSar: 1200 }, seats: 12 });
    const res = await call(u.email, { deal: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { deal: unknown; allowance: number; seats: number } }).user).toMatchObject({ deal: null, allowance: 1500, seats: PLAN_SEATS.business });
    expect((await getUser(acct(u)))!.deal).toBeUndefined();
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

describe("the owner's profile states the allowance the balance renews to (rule 243)", () => {
  it("an Agency deal's credits, Business's without one; the deal's terms without who set it", async () => {
    const u = await account("agency");
    await signIn(u.email);
    const read = async () => (await (await profileRoute.GET()).json()) as { allowance: number; user: Record<string, unknown> };
    expect((await read()).allowance).toBe(PLAN_CREDITS.business);
    await adminSignIn();
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
      saveTask(acct(u), { ...base, id: "media-premium", imageUrl: "https://blob.example/1.png", imageModel: "img-premium", mediaCredits: 2 }, true),
      saveTask(acct(u), { ...base, id: "media-video", videoUrl: "https://blob.example/2.mp4", videoModel: "vid-quick", mediaCredits: 12 }, true),
      saveTask(acct(u), { ...base, id: "media-legacy", imageUrl: "https://blob.example/3.png" }, true),
    ]);
    const p = (await (await profileRoute.GET()).json()) as { images: number; mediaCredits: number };
    expect(p.images, "items with an image or a video").toBe(3);
    expect(p.mediaCredits).toBe(2 + 12 + 1);
  });
});

describe("credits the founder adds are finite and bounded", () => {
  it("1e999, a string or more than 100,000 either way is refused; a bounded number is added", async () => {
    const u = await account("pro");
    const before = (await getUser(acct(u)))!.credits;
    const inf = await raw(`{"email":"${u.email}","addCredits":1e999,"reason":"test reason"}`);
    expect(inf.status).toBe(400);
    expect(await inf.json()).toEqual({ ok: false, error: "bad_credits" });
    for (const addCredits of ["30", 100_001, -100_001, true]) expect((await call(u.email, { addCredits })).status, String(addCredits)).toBe(400);
    expect((await getUser(acct(u)))!.credits).toBe(before);
    expect((await call(u.email, { addCredits: 30.7 })).status).toBe(200);
    expect((await getUser(acct(u)))!.credits).toBe(before + 30);
    expect(Number.isFinite((await getUser(acct(u)))!.credits)).toBe(true);
  });
});

describe("the founder sets an account's chat messages (rule 316)", () => {
  it("an override is a whole number from 0 to MAX_CHAT_OVERRIDE; anything else is bad_chat and writes nothing", async () => {
    const u = await account("pro", "chat");
    const logged = await logLength();
    for (const chatAllowance of [-1, 1.5, "x", "5", MAX_CHAT_OVERRIDE + 1, true, {}, [3]]) {
      const res = await call(u.email, { chatAllowance });
      expect(res.status, JSON.stringify(chatAllowance)).toBe(400);
      expect(await res.json(), JSON.stringify(chatAllowance)).toEqual({ ok: false, error: "bad_chat" });
    }
    const inf = await raw(`{"email":"${u.email}","chatAllowance":1e999,"reason":"test reason"}`);
    expect(inf.status).toBe(400);
    expect(await inf.json()).toEqual({ ok: false, error: "bad_chat" });
    // A bad override refuses the whole request, not only its own part.
    expect((await call(u.email, { chatAllowance: -1, addCredits: 30 })).status).toBe(400);
    const x = (await getUser(acct(u)))!;
    expect(x.chatAllowance).toBeUndefined();
    expect(x.credits).toBe(u.credits);
    expect(await logLength(), "a refused change is not logged as made").toBe(logged);
  });

  it("set, 0 accepted (chat stopped in code), cleared with null or an empty string; each change logged before and after", async () => {
    const u = await account("pro", "chat");
    const res = await call(u.email, { chatAllowance: 2000, reason: "pilot" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: Record<string, unknown> }).user).toMatchObject({ chatAllowance: 2000, chatOverride: 2000 });
    expect((await getUser(acct(u)))!.chatAllowance).toBe(2000);
    expect(await lastLog()).toMatchObject({ what: "chat:2000", before: { chat: CHAT_ALLOWANCE.pro }, after: { chat: 2000 }, reason: "pilot" });

    // A request about something else keeps the override.
    expect((await call(u.email, { addCredits: 5 })).status).toBe(200);
    expect((await getUser(acct(u)))!.chatAllowance).toBe(2000);

    // 0 is an override, not "clear": unlike seats, where 0 goes back to the plan's.
    const zero = await call(u.email, { chatAllowance: 0 });
    expect(zero.status).toBe(200);
    expect(((await zero.json()) as { user: Record<string, unknown> }).user).toMatchObject({ chatAllowance: 0, chatOverride: 0 });
    const stopped = (await getUser(acct(u)))!;
    expect(stopped.chatAllowance).toBe(0);
    expect(chatAllowanceOf(stopped)).toBe(0);
    expect(await lastLog()).toMatchObject({ what: "chat:0", before: { chat: 2000 }, after: { chat: 0 } });
    const gate = await reserveChatTurn(stopped, DEFAULTS.chat);
    expect(gate.ok, "an override of 0 refuses the next message before the model").toBe(false);
    expect(gate).toMatchObject({ error: "chat_allowance" });

    const cleared = await call(u.email, { chatAllowance: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { user: Record<string, unknown> }).user).toMatchObject({ chatAllowance: CHAT_ALLOWANCE.pro, chatOverride: null });
    expect((await getUser(acct(u)))!.chatAllowance).toBeUndefined();
    expect(await lastLog()).toMatchObject({ what: "chat:plan", before: { chat: 0 }, after: { chat: CHAT_ALLOWANCE.pro } });

    await call(u.email, { chatAllowance: 10 });
    expect((await call(u.email, { chatAllowance: "" })).status).toBe(200);
    expect((await getUser(acct(u)))!.chatAllowance, "an empty string clears it too").toBeUndefined();
    expect((await call(u.email, { chatAllowance: MAX_CHAT_OVERRIDE })).status, "the bound itself is accepted").toBe(200);
  });

  it("leaving Agency or clearing the deal clears the chat override, unless the same request sets it", async () => {
    const a = await account("agency", "chat");
    await call(a.email, { deal: { credits: 3003, priceSar: 2000 }, seats: 20, chatAllowance: 4000 });
    expect(chatAllowanceOf((await getUser(acct(a)))!)).toBe(4000);
    expect((await call(a.email, { plan: "pro" })).status).toBe(200);
    const x = (await getUser(acct(a)))!;
    expect(x.chatAllowance, "the deal's chat messages went with the deal").toBeUndefined();
    expect(chatAllowanceOf(x)).toBe(CHAT_ALLOWANCE.pro);
    expect(await lastLog()).toMatchObject({ what: `plan:pro deal:none seats:plan chat:plan${PAID}`, before: { chat: 4000 }, after: { chat: CHAT_ALLOWANCE.pro } });

    const b = await account("agency", "chat");
    await call(b.email, { deal: { credits: 3003, priceSar: 2000 }, chatAllowance: 4000 });
    expect((await call(b.email, { plan: "business", chatAllowance: 3000 })).status).toBe(200);
    expect((await getUser(acct(b)))!.chatAllowance, "a plan change that sets it keeps what it sets").toBe(3000);
    expect((await lastLog()).what).toBe(`plan:business deal:none chat:3000${PAID}`);

    const c = await account("agency", "chat");
    await call(c.email, { deal: { credits: 1500, priceSar: 1200 }, chatAllowance: 2500 });
    expect((await call(c.email, { deal: null })).status).toBe(200);
    expect((await getUser(acct(c)))!.chatAllowance).toBeUndefined();
    expect(await lastLog()).toMatchObject({ what: "deal:none chat:plan", before: { chat: 2500 }, after: { chat: CHAT_ALLOWANCE.business } });

    // No contract ends between two fixed plans: an override given to a Pro account stays when it moves to Business.
    const d = await account("pro", "chat");
    await call(d.email, { chatAllowance: 900 });
    expect((await call(d.email, { plan: "business" })).status).toBe(200);
    expect((await getUser(acct(d)))!.chatAllowance).toBe(900);
  });

  it("GET rows, the detail view and the CSV carry each account's chat; a trial's messages are its trial count", async () => {
    const p = await account("pro", "chat");
    await saveUser({ ...(await getUser(acct(p)))!, chatOverflow: true });
    await Promise.all([db.set(chatMsgKey(acct(p)), 5), db.set(chatOverKey(acct(p)), 1), db.set(chatCredKey(acct(p)), 4)]);
    // Two chat model calls of $0.03 each (claude-sonnet-5: 10,000 input and 1,000 output tokens).
    const usage = { input_tokens: 10_000, output_tokens: 1_000 };
    await meter(acct(p), "claude-sonnet-5-5", "chat", usage);
    await meter(acct(p), "claude-sonnet-5-5", "chat", usage);
    const t = await account("trial", "chat");
    await call(t.email, { chatAllowance: 20 });
    await db.set(chatTrialKey(acct(t)), 12);

    const rows = ((await (await plan.GET(json("/api/admin/plan", "GET", undefined, headers))).json()) as { users: Record<string, unknown>[] }).users;
    expect(rows.find((r) => r.email === p.email)).toMatchObject({
      chatUsed: 5, chatAllowance: CHAT_ALLOWANCE.pro, chatLeft: CHAT_ALLOWANCE.pro - 5, chatPeriod: "month", chatOverride: null,
      chatOverflowOn: true, chatOverflowUsed: 1, chatCredits: 4, chatUsd: 0.06, usdPerMsg: 0.01,
    });
    expect(rows.find((r) => r.email === t.email), "the trial's count, not this month's (which is 0)").toMatchObject({
      chatUsed: 12, chatAllowance: 20, chatLeft: 8, chatPeriod: "trial", chatOverride: 20, chatOverflowOn: false, chatOverflowUsed: 0, chatCredits: 0, chatUsd: 0, usdPerMsg: 0,
    });
    // No message at all: no per-message cost, not a division by zero.
    const idle = await account("starter", "chat");
    expect(((await (await plan.GET(json("/api/admin/plan", "GET", undefined, headers))).json()) as { users: Record<string, unknown>[] }).users.find((r) => r.email === idle.email)).toMatchObject({ chatUsed: 0, chatUsd: 0, usdPerMsg: null });

    const detail = (await (await adminUser.GET(json("/api/admin/users/x", "GET", undefined, headers), params({ email: encodeURIComponent(t.email) }))).json()) as { chat: Record<string, unknown>; chatUsdPerMsg: number | null };
    expect(detail.chat).toMatchObject({ used: 12, counted: 12, allowance: 20, left: 8, period: "trial", overflow: { on: false, available: false, used: 0, credits: 0 } });
    expect(detail.chatUsdPerMsg).toBe(0);
    const pro = (await (await adminUser.GET(json("/api/admin/users/x", "GET", undefined, headers), params({ email: encodeURIComponent(p.email) }))).json()) as { chat: Record<string, unknown>; chatUsdPerMsg: number | null };
    expect(pro.chat).toMatchObject({ used: 5, counted: 5, period: "month", overflow: { on: true, available: true, used: 1, credits: 4 } });
    expect(pro.chatUsdPerMsg, "the detail's cost per message is the list's").toBe(0.01);

    const csv = await (await exportRoute.GET(json("/api/admin/export", "GET", undefined, headers))).text();
    // The export starts with a byte order mark for Excel: the header is read from "email," on.
    const lines = csv.slice(csv.indexOf("email,")).split("\n");
    const cells = (line: string) => line.slice(1, -1).split('","');
    const head = lines[0].split(",");
    const col = head.indexOf("chat_allowance");
    expect(col, "chat_allowance follows monthly_credits").toBe(head.indexOf("monthly_credits") + 1);
    expect(cells(lines.find((l) => l.includes(t.email))!)[col]).toBe("20");
    expect(cells(lines.find((l) => l.includes(p.email))!)[col]).toBe(String(CHAT_ALLOWANCE.pro));
  });

  it("after the allowance was lowered mid-month the row shows the raw count past it, and the cost per message divides by every message", async () => {
    const u = await account("pro", "chat");
    await saveUser({ ...(await getUser(acct(u)))!, chatOverflow: true });
    // 25 sent inside the plan's allowance, then 5 on credits billed 7 credits in all.
    await Promise.all([db.set(chatMsgKey(acct(u)), 25), db.set(chatOverKey(acct(u)), 5), db.set(chatCredKey(acct(u)), 7)]);
    const usage = { input_tokens: 10_000, output_tokens: 1_000 };
    await meter(acct(u), "claude-sonnet-5-5", "chat", usage);
    await meter(acct(u), "claude-sonnet-5-5", "chat", usage);
    expect((await call(u.email, { chatAllowance: 10 })).status).toBe(200);

    const rows = ((await (await plan.GET(json("/api/admin/plan", "GET", undefined, headers))).json()) as { users: Record<string, unknown>[] }).users;
    const row = rows.find((r) => r.email === u.email)!;
    expect(row, "the count past the lowered allowance is shown as it is, nothing left").toMatchObject({
      chatUsed: 25, chatAllowance: 10, chatLeft: 0, chatOverride: 10, chatOverflowUsed: 5, chatCredits: 7, chatUsd: 0.06,
    });
    // $0.06 over 25 + 5 messages. Over the clamped count (10 + 5) it would read 0.004, twice the real cost.
    expect(row.usdPerMsg).toBe(0.002);

    const detail = (await (await adminUser.GET(json("/api/admin/users/x", "GET", undefined, headers), params({ email: encodeURIComponent(u.email) }))).json()) as { chat: Record<string, unknown>; chatUsdPerMsg: number | null };
    expect(detail.chat, "the owner is shown the clamped count; the founder the raw one").toMatchObject({ used: 10, counted: 25, allowance: 10, left: 0, overflow: { on: true, used: 5, credits: 7 } });
    expect(detail.chatUsdPerMsg).toBe(0.002);
  });
});
