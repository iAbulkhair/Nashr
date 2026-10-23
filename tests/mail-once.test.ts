import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";

/**
 * Rules 350-352, 363-365 and 367 (#11). One-time emails (the signup nudge, each lifecycle note) are marked as sent only after Resend
 * accepted them. The old guard claimed a 400-day marker before sending, so every nudge and trial note Resend refused
 * while MAIL_FROM was unset was recorded as done and never retried.
 */

type Send = (msg: { to: string }) => Promise<{ data: unknown; error: { name: string; message: string } | null }>;
let send: Send = async () => ({ data: { id: "re_1" }, error: null });
const sends: string[] = [];

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (msg: { to: string }) => { sends.push(msg.to); return send(msg); } };
  },
}));

const refuse: Send = async () => ({ data: null, error: { name: "validation_error", message: "You can only send testing emails to your own email address" } });
const accept: Send = async () => ({ data: { id: "re_ok" }, error: null });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  sends.length = 0;
  send = accept;
});

const mailOn = () => { vi.stubEnv("RESEND_API_KEY", "re_test_key"); vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>"); };

describe("rule 350: a refused one-time email is not recorded as sent", () => {
  it("a refusal leaves no marker and no claim, so the next run sends it", async () => {
    mailOn();
    const { sendOnce, onceKey, onceClaimKey } = await import("@/lib/notify");
    const email = (await newUser("once-refused")).email;

    send = refuse;
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("failed");
    expect(await db.get(onceKey(email, "nudge1")), "a refused send must not burn the 400-day marker").toBeFalsy();
    expect(await db.get(onceClaimKey(email, "nudge1")), "the claim is released on failure").toBeFalsy();

    send = accept;
    expect(await sendOnce(email, "nudge1", "s", "t"), "the next run retries the refused email").toBe("sent");
    expect(sends.filter((to) => to === email)).toHaveLength(2);
  });

  it("an accepted email is never sent again", async () => {
    mailOn();
    const { sendOnce, onceKey } = await import("@/lib/notify");
    const email = (await newUser("once-sent")).email;
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("sent");
    expect(await db.get(onceKey(email, "lifecycle:day1"))).toBeTruthy();
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("already");
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("already");
    expect(sends.filter((to) => to === email), "once Resend accepted it, it is never resent").toHaveLength(1);
  });

  it("two overlapping runs send it once", async () => {
    mailOn();
    const { sendOnce } = await import("@/lib/notify");
    const email = (await newUser("once-race")).email;
    const results = await Promise.all(Array.from({ length: 5 }, () => sendOnce(email, "nudge1", "s", "t")));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(sends.filter((to) => to === email)).toHaveLength(1);
  });

  it("a marker written by the old guard still counts as sent while mail cannot reach customers", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "");
    const { sendOnce, onceKey } = await import("@/lib/notify");
    const email = (await newUser("once-legacy")).email;
    await db.lock(onceKey(email, "nudge1"), 400 * 86400);
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("already");
    expect(await db.get(onceKey(email, "nudge1")), "left in place until MAIL_FROM is set").toBeTruthy();
    expect(sends).toHaveLength(0);
  });
});

describe("rule 351: lifecycle mail waits for a sender that can reach customers", () => {
  const dayOne = async (prefix: string) => {
    const u = await newUser(prefix);
    const { saveUser, getUser } = await import("@/lib/auth");
    const { saveBrand } = await import("@/lib/brand");
    await saveUser({ ...u, createdAt: new Date(Date.now() - 1.5 * 864e5).toISOString(), trialEnds: new Date(Date.now() + 5 * 864e5).toISOString() });
    await saveBrand(u.email, { name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "", products: "قهوة", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: new Date().toISOString() });
    return (await getUser(u.email))!;
  };

  it("with RESEND_API_KEY but no MAIL_FROM, nothing is sent and no marker is taken", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "");
    const u = await dayOne("life-nofrom");
    const { runLifecycle } = await import("@/lib/lifecycle");
    const { onceKey } = await import("@/lib/notify");
    expect(await runLifecycle(u)).toEqual([]);
    expect(await db.get(onceKey(u.email, "lifecycle:day1"))).toBeFalsy();
    expect(sends).toHaveLength(0);
  });

  it("a refused day-one note is retried on the next run and then never again", async () => {
    mailOn();
    const u = await dayOne("life-retry");
    const { runLifecycle } = await import("@/lib/lifecycle");
    send = refuse;
    expect(await runLifecycle(u)).toEqual([]);
    send = accept;
    expect(await runLifecycle(u)).toEqual(["day1"]);
    expect(await runLifecycle(u)).toEqual([]);
    expect(sends.filter((to) => to === u.email)).toHaveLength(2);
  });

  it("no lifecycle template carries a placeholder signature", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/lifecycle.ts", "utf8"));
    expect(src).not.toMatch(/\[Your name\]|\[اسمك\]/);
  });
});

describe("rule 352: the signup nudge uses the same claim-then-confirm guard", () => {
  it("the daily route does not burn the nudge marker before the send", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/app/api/cron/daily/route.ts", "utf8"));
    expect(src).toMatch(/sendOnce\(acct\(u\), "nudge1"/);
    expect(src, "the nudge is gated on mail that can reach customers, not on the key alone").toMatch(/mailReady\(\)\)/);
    const notify = await import("node:fs").then((fs) => fs.readFileSync("src/lib/notify.ts", "utf8"));
    expect(notify, "the old claim-before-send guard is gone").not.toMatch(/export async function once\(/);
  });

  it("the daily cron reports a refused nudge, leaves no marker, retries it on the next run and never sends a third", async () => {
    mailOn();
    vi.stubEnv("CRON_SECRET", "cron-secret-mail-once");
    const { saveUser } = await import("@/lib/auth");
    const { onceKey } = await import("@/lib/notify");
    const daily = await import("@/app/api/cron/daily/route");
    const u = await newUser("nudge-cron");
    await saveUser({ ...u, createdAt: new Date(Date.now() - 3600e3).toISOString() });
    type Report = { results: Record<string, string>; nudges: number };
    const run = async (): Promise<{ mine: string; nudges: number }> => {
      // A run marks each workspace done for the day; a later day's run is what retries, so the day markers are cleared.
      const day = new Date().toISOString().slice(0, 10);
      await Promise.all([db.del(`crondone:daily:${day}:${u.email}`), db.del(`crontry:daily:${day}:${u.email}`)]);
      const r = await daily.GET(new Request("https://nashr.test/api/cron/daily?chain=1", { headers: { authorization: "Bearer cron-secret-mail-once" } }));
      expect(r.status).toBe(200);
      const body = (await r.json()) as Report;
      return { mine: body.results[u.email] ?? "", nudges: body.nudges };
    };

    send = refuse;
    const first = await run();
    expect(first.mine).toBe("mail_refused:nudge");
    expect(first.nudges, "a refused nudge is not counted as sent").toBe(0);
    expect(await db.get(onceKey(u.email, "nudge1")), "and leaves no 400-day marker").toBeFalsy();

    send = accept;
    const second = await run();
    expect(second.mine).toBe("nudge");
    expect(second.nudges).toBeGreaterThanOrEqual(1);
    expect(await db.get(onceKey(u.email, "nudge1"))).toBeTruthy();

    const third = await run();
    expect(third.mine).toBe("no_brand");
    expect(sends.filter((to) => to === u.email), "one refused attempt, one accepted, no third").toHaveLength(2);
  });

  it("an account deletion removes the marker, the claim and the index", async () => {
    await atTestNow();
    mailOn();
    const { sendOnce, onceKey, onceClaimKey, onceRepairKey, ONCE_INDEX } = await import("@/lib/notify");
    const { wipeAccount } = await import("@/lib/account");
    const email = (await newUser("once-wipe")).email;
    await sendOnce(email, "nudge1", "s", "t");
    await db.lock(onceClaimKey(email, "lifecycle:day2"), 120);
    await db.sadd(ONCE_INDEX(email), "lifecycle:day2");
    // A repaired old-guard marker leaves a repair flag (rule 363); it goes with the account too.
    await burn(email, "lifecycle:day1");
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("sent");
    await wipeAccount(email);
    expect(await db.get(onceKey(email, "nudge1"))).toBeFalsy();
    expect(await db.get(onceKey(email, "lifecycle:day1"))).toBeFalsy();
    expect(await db.get(onceRepairKey(email, "lifecycle:day1")), "the repair flag is removed").toBeFalsy();
    expect(await db.get(onceClaimKey(email, "lifecycle:day2"))).toBeFalsy();
    expect(await db.smembers(ONCE_INDEX(email))).toEqual([]);
  });
});

/**
 * Rules 363-365 (founder decision 2026-10-01). The old guard burned a marker before every send, and every send since
 * RESEND_API_KEY arrived (2026-09-18) was refused for want of MAIL_FROM. Once MAIL_FROM is live, an account that still
 * qualifies for a message whose marker was burned gets it, once; one that received it under `markSent` never does.
 */
/**
 * Old-guard markers are repaired only when written before `REPAIR_BEFORE` (rule 367), which the code works out from the
 * marker's remaining TTL and `repairClock`. These tests pin that clock a few days after the cutoff, so they never depend
 * on the day CI runs, and `burn` writes the marker as the old guard did (SET NX EX 400 days) as if at `writtenAt`: it
 * leaves the TTL such a marker would still have at TEST_NOW. (Faking `Date` itself breaks the `resend` mock under the
 * daily cron, so only the repair clock is pinned.)
 */
const TEST_NOW = Date.parse("2026-10-05T09:00:00.000Z");
async function atTestNow() {
  const { repairClock } = await import("@/lib/notify");
  vi.spyOn(repairClock, "now").mockReturnValue(TEST_NOW);
}
async function burn(email: string, key: string, writtenAt = "2026-09-25T09:00:00.000Z") {
  await db.lock(`notified:${email}:${key}`, 400 * 86400 - (TEST_NOW - Date.parse(writtenAt)) / 1000);
}

describe("rule 363: a burned marker is cleared once, when mail can reach customers and the message is due", () => {
  beforeEach(atTestNow);
  it("sends the message once, marks it confirmed and sets the repair flag", async () => {
    mailOn();
    const { sendOnce, onceKey, onceRepairKey, confirmedMarker } = await import("@/lib/notify");
    const email = (await newUser("repair-once")).email;
    await burn(email, "nudge1");
    expect(confirmedMarker(await db.get(onceKey(email, "nudge1"))), "the old guard's marker carries no proof of delivery").toBe(false);
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("sent");
    expect(confirmedMarker(await db.get(onceKey(email, "nudge1"))), "the new marker records the accepted send").toBe(true);
    expect(await db.get(onceRepairKey(email, "nudge1"))).toBeTruthy();
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("already");
    expect(sends.filter((to) => to === email)).toHaveLength(1);
  });

  it("a repaired send that is refused is retried like any other, and the old marker is never cleared twice", async () => {
    mailOn();
    const { sendOnce, onceKey, onceRepairKey } = await import("@/lib/notify");
    const email = (await newUser("repair-refused")).email;
    await burn(email, "lifecycle:day1");
    send = refuse;
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("failed");
    expect(await db.get(onceKey(email, "lifecycle:day1")), "no marker: the next run sends it").toBeFalsy();
    expect(await db.get(onceRepairKey(email, "lifecycle:day1"))).toBeTruthy();
    send = accept;
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("sent");
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("already");
    expect(sends.filter((to) => to === email), "one refused, one accepted").toHaveLength(2);
  });

  it("with the repair flag already taken, an old marker stands", async () => {
    mailOn();
    const { sendOnce, onceKey, onceRepairKey } = await import("@/lib/notify");
    const email = (await newUser("repair-flag")).email;
    await burn(email, "nudge1");
    await db.lock(onceRepairKey(email, "nudge1"), 400 * 86400);
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("already");
    expect(await db.get(onceKey(email, "nudge1"))).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it("five overlapping runs on a burned marker send once", async () => {
    mailOn();
    const { sendOnce } = await import("@/lib/notify");
    const email = (await newUser("repair-race")).email;
    await burn(email, "nudge1");
    const results = await Promise.all(Array.from({ length: 5 }, () => sendOnce(email, "nudge1", "s", "t")));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(sends.filter((to) => to === email)).toHaveLength(1);
  });
});

describe("rule 364: a message Resend accepted is never sent again, and nothing is repaired without MAIL_FROM", () => {
  beforeEach(atTestNow);
  it("a marker written by markSent is never cleared", async () => {
    mailOn();
    const { sendOnce, markSent, onceKey, onceRepairKey } = await import("@/lib/notify");
    const email = (await newUser("repair-confirmed")).email;
    await markSent(email, "nudge1");
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("already");
    expect(await db.get(onceKey(email, "nudge1"))).toBeTruthy();
    expect(await db.get(onceRepairKey(email, "nudge1")), "no repair is taken on a confirmed marker").toBeFalsy();
    expect(sends).toHaveLength(0);
  });

  it("with the key but no MAIL_FROM, a burned marker is left alone and no repair flag is spent", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "");
    const { sendOnce, onceKey, onceRepairKey } = await import("@/lib/notify");
    const email = (await newUser("repair-nofrom")).email;
    await burn(email, "lifecycle:day1");
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("already");
    expect(await db.get(onceKey(email, "lifecycle:day1"))).toBeTruthy();
    expect(await db.get(onceRepairKey(email, "lifecycle:day1"))).toBeFalsy();
    expect(sends).toHaveLength(0);
  });
});

describe("rule 365: the senders repair only accounts that still qualify", () => {
  beforeEach(atTestNow);
  const withBrand = async (prefix: string, ageDays: number) => {
    const u = await newUser(prefix);
    const { saveUser, getUser } = await import("@/lib/auth");
    const { saveBrand } = await import("@/lib/brand");
    await saveUser({ ...u, createdAt: new Date(Date.now() - ageDays * 864e5).toISOString(), trialEnds: new Date(Date.now() + 5 * 864e5).toISOString() });
    await saveBrand(u.email, { name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "", products: "قهوة", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: new Date().toISOString() });
    return (await getUser(u.email))!;
  };

  it("a burned day-one note goes out once while its window lasts; one past its window keeps its marker", async () => {
    mailOn();
    const { runLifecycle } = await import("@/lib/lifecycle");
    const { onceKey, onceRepairKey } = await import("@/lib/notify");
    const due = await withBrand("repair-life-due", 1.5);
    await burn(due.email, "lifecycle:day1");
    expect(await runLifecycle(due)).toEqual(["day1"]);
    expect(await runLifecycle(due)).toEqual([]);
    expect(sends.filter((to) => to === due.email)).toHaveLength(1);

    const late = await withBrand("repair-life-late", 6);
    await burn(late.email, "lifecycle:day1");
    expect(await runLifecycle(late)).toEqual([]);
    expect(await db.get(onceKey(late.email, "lifecycle:day1")), "no longer due: not repaired").toBeTruthy();
    expect(await db.get(onceRepairKey(late.email, "lifecycle:day1"))).toBeFalsy();
    expect(sends.filter((to) => to === late.email)).toHaveLength(0);
  });

  it("through the daily cron, a burned nudge reaches an account that still has no brand once, and never one that built a brand", async () => {
    mailOn();
    vi.stubEnv("CRON_SECRET", "cron-secret-mail-repair");
    const { saveUser } = await import("@/lib/auth");
    const { onceKey, onceRepairKey, confirmedMarker } = await import("@/lib/notify");
    const daily = await import("@/app/api/cron/daily/route");
    const noBrand = await newUser("repair-nudge");
    await saveUser({ ...noBrand, createdAt: new Date(Date.now() - 5 * 864e5).toISOString() });
    await burn(noBrand.email, "nudge1");
    const built = await withBrand("repair-nudge-built", 20);
    await burn(built.email, "nudge1");
    const run = async (): Promise<Record<string, string>> => {
      const day = new Date().toISOString().slice(0, 10);
      await Promise.all([noBrand.email, built.email].flatMap((e) => [db.del(`crondone:daily:${day}:${e}`), db.del(`crontry:daily:${day}:${e}`)]));
      const r = await daily.GET(new Request("https://nashr.test/api/cron/daily?chain=1", { headers: { authorization: "Bearer cron-secret-mail-repair" } }));
      expect(r.status).toBe(200);
      return ((await r.json()) as { results: Record<string, string> }).results;
    };
    const first = await run();
    expect(first[noBrand.email]).toBe("nudge");
    expect((await run())[noBrand.email]).toBe("no_brand");
    expect(sends.filter((to) => to === noBrand.email), "the burned nudge goes out once").toHaveLength(1);
    // The brand account may get its daily brief; what matters is that the nudge path never ran for it.
    expect(first[built.email] ?? "").not.toMatch(/nudge/);
    const marker = await db.get(onceKey(built.email, "nudge1"));
    expect(marker, "an account that built a brand no longer qualifies: its old marker stands").toBeTruthy();
    expect(confirmedMarker(marker)).toBe(false);
    expect(await db.get(onceRepairKey(built.email, "nudge1"))).toBeFalsy();
  });
});

describe("rule 367: only markers the old guard wrote before REPAIR_BEFORE are repaired, whatever the deploy order", () => {
  beforeEach(atTestNow);

  it("a marker written after the cutoff (MAIL_FROM live before this code: the send succeeded) is never cleared", async () => {
    mailOn();
    const { sendOnce, onceKey, onceRepairKey, REPAIR_BEFORE } = await import("@/lib/notify");
    expect(Date.parse(REPAIR_BEFORE)).toBeLessThan(TEST_NOW);
    const email = (await newUser("repair-after-cutoff")).email;
    await burn(email, "nudge1", "2026-10-03T09:00:00.000Z");
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("already");
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("already");
    expect(await db.get(onceKey(email, "nudge1")), "the old marker stands").toBeTruthy();
    expect(await db.get(onceRepairKey(email, "nudge1")), "no repair flag is spent").toBeFalsy();
    expect(sends).toHaveLength(0);
  });

  it("the boundary is exact: one second before the cutoff is repaired, the cutoff itself is not", async () => {
    mailOn();
    const { sendOnce, REPAIR_BEFORE, writtenBeforeRepairCutoff, onceKey } = await import("@/lib/notify");
    const before = (await newUser("repair-edge-before")).email;
    const at = (await newUser("repair-edge-at")).email;
    await burn(before, "nudge1", new Date(Date.parse(REPAIR_BEFORE) - 1000).toISOString());
    await burn(at, "nudge1", REPAIR_BEFORE);
    expect(await writtenBeforeRepairCutoff(onceKey(before, "nudge1"))).toBe(true);
    expect(await writtenBeforeRepairCutoff(onceKey(at, "nudge1"))).toBe(false);
    expect(await sendOnce(before, "nudge1", "s", "t")).toBe("sent");
    expect(await sendOnce(at, "nudge1", "s", "t")).toBe("already");
    expect(sends).toEqual([before]);
  });

  it("a marker with no expiry predates the 400-day guard and is repaired once; a missing key has nothing to repair", async () => {
    mailOn();
    const { sendOnce, writtenBeforeRepairCutoff, onceKey } = await import("@/lib/notify");
    const email = (await newUser("repair-no-ttl")).email;
    await db.set(onceKey(email, "lifecycle:day1"), 1);
    expect(await db.ttl(onceKey(email, "lifecycle:day1"))).toBe(-1);
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("sent");
    expect(await sendOnce(email, "lifecycle:day1", "s", "t")).toBe("already");
    expect(await db.ttl(onceKey(email, "absent"))).toBe(-2);
    expect(await writtenBeforeRepairCutoff(onceKey(email, "absent"))).toBe(false);
    expect(sends.filter((to) => to === email)).toHaveLength(1);
  });

  it("through the daily cron, a nudge marker the old guard wrote after the cutoff is not sent again", async () => {
    mailOn();
    vi.stubEnv("CRON_SECRET", "cron-secret-mail-cutoff");
    const { saveUser } = await import("@/lib/auth");
    const { onceKey } = await import("@/lib/notify");
    const daily = await import("@/app/api/cron/daily/route");
    const u = await newUser("repair-cutoff-cron");
    await saveUser({ ...u, createdAt: new Date(Date.now() - 5 * 864e5).toISOString() });
    await burn(u.email, "nudge1", "2026-10-02T09:00:00.000Z");
    const r = await daily.GET(new Request("https://nashr.test/api/cron/daily?chain=1", { headers: { authorization: "Bearer cron-secret-mail-cutoff" } }));
    expect(r.status).toBe(200);
    const results = ((await r.json()) as { results: Record<string, string> }).results;
    expect(results[u.email]).toBe("no_brand");
    expect(await db.get(onceKey(u.email, "nudge1"))).toBeTruthy();
    expect(sends.filter((to) => to === u.email)).toHaveLength(0);
  });
});
