import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { newOpaqueUser, newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { accountKey } from "@/lib/keys";
import { acct } from "@/lib/account-id";
import { getUser, saveUser, sc, type User } from "@/lib/auth";
import { saveBrands, scopeFor } from "@/lib/brands";
import { charge } from "@/lib/credits";
import { runCronBatch } from "@/lib/cron-batch";
import { jobRef, resumeJob, runAsAccount } from "@/lib/job-account";
import { digestFor, saveDigest } from "@/lib/notif-digest";

const sent: { to: string }[] = [];
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (m: { to: string }) => {
    sent.push({ to: m.to });
    return true;
  },
}));

/**
 * Rules 2500-2519: every background job carries the account it acts for and reads it again when it runs (pattern 6 of
 * docs/reports/2026-10-19-PRD-fizzy-orca_AR.md, after Fizzy's jobs restoring `Current.account`).
 * docs/system/tests/2500-jobs-carry-account.md lists what each test pins.
 */
const read = (p: string) => readFileSync(p, "utf8");
const H = 36e5;
let period = 0;
const req = () => new Request("https://nashr.example/api/cron/weekly", { headers: { authorization: "Bearer test" } });

beforeEach(() => {
  period++;
  sent.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("rule 2500: an entry carries its account, taken from the roster's record", () => {
  it("jobRef is acct(u) and sc(u), including an added brand and an opaque id", async () => {
    const u = await newUser("jr");
    expect(jobRef(u)).toEqual({ account: acct(u), scope: acct(u) });
    const o = await newOpaqueUser("jr");
    const brand = { ...o, brandId: "b2", scope: scopeFor(acct(o), "b2") };
    expect(jobRef(brand)).toEqual({ account: acct(o), scope: `${acct(o)}#b2` });
    expect(jobRef(o).account).not.toBe(o.email);
  });
});

describe("rules 2501-2505: the run reads the account again and skips with no write", () => {
  it("hands the work a fresh copy, not the roster's (rule 2501)", async () => {
    const u = await newUser("jr");
    const ref = jobRef(u);
    await saveUser({ ...(await getUser(acct(u)))!, credits: 777 });
    const r = await resumeJob(ref);
    expect(r.ok && r.user.credits).toBe(777);
    expect(r.ok && [r.user.scope, r.user.brandId]).toEqual([acct(u), "default"]);
  });
  it("a scope that is not the carried account's is refused before any read (rule 2502)", async () => {
    const [a, b] = await Promise.all([newUser("jr"), newUser("jr")]);
    const get = vi.spyOn(db, "get");
    expect(await resumeJob({ account: acct(a), scope: sc(b) })).toEqual({ ok: false, skip: "skip:scope_mismatch" });
    expect(await resumeJob({ account: "", scope: "" })).toEqual({ ok: false, skip: "skip:scope_mismatch" });
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });
  it("a deleted account, or a record keyed elsewhere, is skipped (rule 2503)", async () => {
    const u = await newUser("jr");
    const ref = jobRef(u);
    const raw = await db.get<User>(accountKey.user(acct(u)));
    await db.set(accountKey.user(acct(u)), { ...raw, id: undefined, email: "someone-else@test.example" });
    expect(await resumeJob(ref)).toEqual({ ok: false, skip: "skip:account_changed" });
    await db.del(accountKey.user(acct(u)));
    expect(await resumeJob(ref)).toEqual({ ok: false, skip: "skip:account_gone" });
  });
  it("a suspended account and an unverified owner are skipped (rule 2504)", async () => {
    const u = await newUser("jr");
    await saveUser({ ...(await getUser(acct(u)))!, suspended: true });
    expect(await resumeJob(jobRef(u))).toEqual({ ok: false, skip: "skip:suspended" });
    const v = await newUser("jr", { verified: false });
    expect(await resumeJob(jobRef(v))).toEqual({ ok: false, skip: "skip:unverified" });
  });
  it("an archived brand, or a brand the account does not have, is skipped (rule 2505)", async () => {
    const u = await newUser("jr");
    const at = new Date().toISOString();
    await saveBrands(acct(u), [{ id: "default", name: "", createdAt: at, status: "active" }, { id: "b2", name: "Two", createdAt: at, status: "active" }]);
    const ref = { account: acct(u), scope: scopeFor(acct(u), "b2") };
    const ok = await resumeJob(ref);
    expect(ok.ok && [ok.user.brandId, ok.user.scope]).toEqual(["b2", ref.scope]);
    await saveBrands(acct(u), [{ id: "default", name: "", createdAt: at, status: "active" }, { id: "b2", name: "Two", createdAt: at, status: "archived" }]);
    expect(await resumeJob(ref)).toEqual({ ok: false, skip: "skip:brand_inactive" });
    expect(await resumeJob({ account: acct(u), scope: scopeFor(acct(u), "nope") })).toEqual({ ok: false, skip: "skip:brand_inactive" });
  });
});

describe("rule 2506: a per-user cron starts work only through runAsAccount", () => {
  it("an account suspended after the listing is not charged, and its item is done for the period", async () => {
    const [keep, stop] = await Promise.all([newUser("jr"), newUser("jr")]);
    const items = [keep, stop].map((u) => ({ u, ref: jobRef(u) }));
    // Between the listing and the run, the founder suspends one account.
    await saveUser({ ...(await getUser(acct(stop)))!, suspended: true });
    const ran: string[] = [];
    const o = {
      job: "jobs-carry", period: `p${period}`, items, id: (x: (typeof items)[number]) => sc(x.u), concurrency: 2, startBudgetMs: 5000, markerTtlSeconds: 60, req: req(),
      run: (x: (typeof items)[number]) => runAsAccount(x.ref, async (u) => {
        ran.push(acct(u));
        await charge(acct(u), 5, { scope: sc(u), agent: "noor" });
        return "ran";
      }),
    };
    const before = (await getUser(acct(stop)))!.credits;
    const r = await runCronBatch(o);
    expect(ran).toEqual([acct(keep)]);
    expect(r.results[sc(stop)]).toBe("skip:suspended");
    expect((await getUser(acct(stop)))!.credits).toBe(before);
    expect((await getUser(acct(keep)))!.credits).toBe(keep.credits - 5);
    // A skip is a final outcome: the next hop of the same period does not start it again.
    const again = await runCronBatch({ ...o, req: req() });
    expect(again).toMatchObject({ alreadyDone: 2, processed: 0 });
  });
  it("every per-user cron route carries the ref from its listing and runs through runAsAccount", () => {
    for (const r of ["daily", "weekly", "routines", "evening", "stores"]) {
      const src = read(`src/app/api/cron/${r}/route.ts`);
      expect(src, r).toContain("ref: jobRef(");
      expect(src, r).toMatch(/run: \(x\) => (\("user" in x \? )?runAsAccount\(x\.ref, /);
    }
  });
  it("nothing in the batch reaches a key from the request: the ref comes from acct and sc only", () => {
    const src = read("src/lib/job-account.ts");
    expect(src).toContain("({ account: acct(u), scope: sc(u) })");
    expect(src).not.toMatch(/req\b|searchParams|headers/);
  });
});

describe("rules 2507-2509: the digest reads its account again before it sends", () => {
  it("a suspended or unverified account is held with its window open, and nothing is sent (rule 2508)", async () => {
    const u = await newUser("jd");
    const a = acct(u);
    await saveDigest(a, "4h", a, "en");
    const start = Date.parse((await db.get<string>(accountKey.digestLast(a)))!);
    await db.set(accountKey.notifications(a), [{ id: "x", kind: "pending", title: "T", body: "b", href: "/en/app", at: new Date(start + H).toISOString() }]);
    await saveUser({ ...(await getUser(a))!, suspended: true });
    expect(await digestFor(a, start + 4 * H)).toBe("held");
    expect(sent).toHaveLength(0);
    expect(await db.get(accountKey.digestLast(a))).toBe(new Date(start).toISOString());
    await saveUser({ ...(await getUser(a))!, suspended: false });
    expect(await digestFor(a, start + 4 * H)).toBe("sent");
  });
  it("a gone account leaves the tick's set and its choice goes (rule 2507)", async () => {
    const u = await newUser("jd");
    const a = acct(u);
    await saveDigest(a, "4h", a, "en");
    const start = Date.parse((await db.get<string>(accountKey.digestLast(a)))!);
    await db.del(accountKey.user(a));
    expect(await digestFor(a, start + 4 * H)).toBe("off");
    expect(await db.get(accountKey.digest(a))).toBeNull();
    expect(sent).toHaveLength(0);
  });
  it("the email goes to the account's current address, not the one saved with the choice (rule 2509)", async () => {
    const u = await newUser("jd");
    const a = acct(u);
    await saveDigest(a, "4h", "old-address@test.example", "en");
    const start = Date.parse((await db.get<string>(accountKey.digestLast(a)))!);
    await db.set(accountKey.notifications(a), [{ id: "y", kind: "pending", title: "T", body: "b", href: "/en/app", at: new Date(start + H).toISOString() }]);
    expect(await digestFor(a, start + 4 * H)).toBe("sent");
    expect(sent).toEqual([{ to: u.email }]);
  });
});
