import { afterEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";

/**
 * Rules 350-352 (#11). One-time emails (the signup nudge, each lifecycle note) are marked as sent only after Resend
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

  it("a marker written by the old guard still counts as sent", async () => {
    mailOn();
    const { sendOnce, onceKey } = await import("@/lib/notify");
    const email = (await newUser("once-legacy")).email;
    await db.lock(onceKey(email, "nudge1"), 400 * 86400);
    expect(await sendOnce(email, "nudge1", "s", "t")).toBe("already");
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
    expect(src).toMatch(/sendOnce\(u\.email, "nudge1"/);
    expect(src, "the nudge is gated on mail that can reach customers, not on the key alone").toMatch(/mailReady\(\)\)/);
    const notify = await import("node:fs").then((fs) => fs.readFileSync("src/lib/notify.ts", "utf8"));
    expect(notify, "the old claim-before-send guard is gone").not.toMatch(/export async function once\(/);
  });

  it("an account deletion removes the marker, the claim and the index", async () => {
    mailOn();
    const { sendOnce, onceKey, onceClaimKey, ONCE_INDEX } = await import("@/lib/notify");
    const { wipeAccount } = await import("@/lib/account");
    const email = (await newUser("once-wipe")).email;
    await sendOnce(email, "nudge1", "s", "t");
    await db.lock(onceClaimKey(email, "lifecycle:day2"), 120);
    await db.sadd(ONCE_INDEX(email), "lifecycle:day2");
    await wipeAccount(email);
    expect(await db.get(onceKey(email, "nudge1"))).toBeFalsy();
    expect(await db.get(onceClaimKey(email, "lifecycle:day2"))).toBeFalsy();
    expect(await db.smembers(ONCE_INDEX(email))).toEqual([]);
  });
});
