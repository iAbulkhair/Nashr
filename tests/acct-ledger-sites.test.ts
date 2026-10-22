import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";

// Claude paused: a render's prompt comes from the fixed template, so no model call is made.
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" as const }));

import { db } from "@/lib/db";
import { getAccount, saveUser, sc, type User } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { accountKey } from "@/lib/keys";
import { saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { chargeOnboard } from "@/lib/credits";
import { pushNotif } from "@/lib/notifications";
import { sweepOnboardHolds } from "@/lib/onboard-confirm";
import { SHARE_CREDITS } from "@/lib/referral";
import { renderImage } from "@/lib/media/start";
import { getJob } from "@/lib/media/jobs";
import { deadlineFor } from "@/lib/media/keys";
import { fakeAdapter, fakeDeps, mediaEnv, noNetwork, resetMediaCounters } from "./helpers/media";
import { json, newOpaqueUser, settle, signIn, signOut } from "./helpers/session";
import * as shareRoute from "@/app/api/referral/share/route";
import * as notificationsRoute from "@/app/api/notifications/route";

/**
 * Rule 1985, the ledger and account calls: with an account whose id is not its sign-in address (the shape `createWorkspace`,
 * `acceptTransfer` and an R2 address move already produce), every charge, refund, hold and bell write lands on
 * `user:{id}` / the id's keys, and nothing is ever read or written at `user:{address}`. Each of these failed with
 * `user_not_found` (or a 404) while the call sites passed `u.email`.
 */

const net = noNetwork();
afterAll(() => { net.restore(); vi.unstubAllEnvs(); });
beforeEach(async () => { resetMediaCounters(); signOut(); await settle(); });
afterEach(async () => { await settle(); vi.restoreAllMocks(); signOut(); });

const credits = async (u: User) => (await getAccount(acct(u)))!.credits;
const brand: Brand = { name: "Rose Coffee", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "coffee", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: new Date().toISOString() };

describe("rule 1985: ledger and account calls name the account id, never the sign-in address", () => {
  it("an opaque account's id differs from its address, and nothing lives at user:{address}", async () => {
    const o = await newOpaqueUser("ls");
    expect(acct(o)).not.toBe(o.email);
    expect(await db.get(accountKey.user(o.email))).toBeNull();
  });

  it("the referral share credit lands on the account id's record", async () => {
    const o = await newOpaqueUser("rs");
    const before = await credits(o);
    await signIn(o.email);
    const res = await shareRoute.POST(json("/api/referral/share", "POST", { platform: "x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, credited: SHARE_CREDITS, credits: before + SHARE_CREDITS });
    expect(await credits(o)).toBe(before + SHARE_CREDITS);
    expect(await db.get(accountKey.user(o.email)), "no record was created at the address").toBeNull();
    // A second claim of the same platform pays nothing.
    const again = await shareRoute.POST(json("/api/referral/share", "POST", { platform: "x" }));
    expect(await again.json()).toMatchObject({ credited: 0, already: true });
    expect(await credits(o)).toBe(before + SHARE_CREDITS);
  });

  it("an old per-platform share marker under the address still counts as claimed, so it is never paid twice", async () => {
    const o = await newOpaqueUser("rsl");
    const before = await credits(o);
    await db.set(accountKey.shared(o.email, "linkedin"), 1);
    await signIn(o.email);
    const res = await shareRoute.POST(json("/api/referral/share", "POST", { platform: "linkedin" }));
    expect(await res.json()).toMatchObject({ credited: 0, already: true });
    expect(await credits(o)).toBe(before);
    expect((await (await shareRoute.GET()).json()).done).toContain("linkedin");
  });

  it("a media render is charged to the account id, and its job names the id", async () => {
    mediaEnv({ fal: true, store: true });
    const o = await newOpaqueUser("md");
    Object.assign(o, { plan: "pro" });
    await saveUser(o);
    await saveBrand(sc(o), brand);
    const t: Task = { id: `ls${randomBytes(4).toString("hex")}`, type: "social", channel: "instagram", title: "Weekend offer", body: "Two for one.", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
    await saveTask(sc(o), t, true);
    const before = await credits(o);
    const r = await renderImage(o, t, brand, undefined, { deadline: deadlineFor(300), deps: fakeDeps({ fal: fakeAdapter("fal") }) });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok || "placeholder" in r) throw new Error("expected a render");
    expect(r.credits).toBe(before - 1);
    expect(await credits(o)).toBe(before - 1);
    const job = await getJob(sc(o), r.job.id);
    expect(job?.email, "the job's account is the id: its refund, meter and notice reach the same account").toBe(acct(o));
    expect(await db.get(accountKey.user(o.email))).toBeNull();
  });

  it("the daily sweep refunds a stale onboarding hold on the account id's record", async () => {
    const o = await newOpaqueUser("ob");
    const before = await credits(o);
    const scope = sc(o);
    const c = await chargeOnboard(acct(o), 5, { scope, agent: "noor" });
    expect(c.ok).toBe(true);
    const held = (await getAccount(acct(o)))!;
    await saveUser({ ...held, onboardPaid: { ...held.onboardPaid, [scope]: { ...held.onboardPaid![scope], at: new Date(Date.now() - 864e5).toISOString() } } });
    const swept = await sweepOnboardHolds((await getAccount(acct(o)))!);
    expect(swept?.refunded.map((r) => r.scope)).toEqual([scope]);
    expect(await credits(o)).toBe(before);
    expect((await getAccount(acct(o)))!.onboardPaid).toBeUndefined();
  });

  it("marking one bell entry read finds it on the account's own bell", async () => {
    const o = await newOpaqueUser("nb");
    const n = await pushNotif(acct(o), { kind: "info", title: "Hello", body: "One", href: "" });
    expect(n).not.toBeNull();
    await signIn(o.email);
    const res = await notificationsRoute.POST(json("/api/notifications", "POST", { id: n!.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, unread: 0 });
  });
});
