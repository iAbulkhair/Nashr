import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ALL_VIDEO_MODELS, entitlementView, entitlements, grantActive, isUtcDay, type EntUser } from "@/lib/entitlements";
import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { chatStatus } from "@/lib/chat-allowance";
import { seatsUsed } from "@/lib/team";
import { chatTrialKey } from "@/lib/usage";
import { newUser } from "./helpers/session";
import { AGENT_IDS } from "@/lib/agents";
import { allowanceOf, chatAllowanceOf, seatLimit } from "@/lib/pricing";
import { chatCaps } from "@/lib/rate";
import { MEDIA_MODELS, TRIAL_VIDEO_MODELS } from "@/lib/media-catalog";
import EntitlementsTable from "@/components/app/EntitlementsTable";
import type { Billing } from "@/lib/billing-state";

/**
 * Rule 780: `entitlements(u)` is the one place that says what an account's plan includes. It reads only the record and
 * constants, so these tests are pure: no db, no clock but the `now` they pass. The last block (rule 784) is the founder
 * console's view of one stored account, which reads the db (the global setup file gives an in-memory one, ruling R6).
 */
const NOW = Date.parse("2026-10-08T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86400_000).toISOString().slice(0, 10);
const grant = (until: string) => ({ video: { value: "all" as const, until, by: "founder@x", at: "2026-10-08T00:00:00Z" } });

const user = (p: Partial<EntUser> = {}): EntUser => ({ plan: "pro", trialEnds: "2099-01-01T00:00:00Z", ...p });
const billingFixture = (p: Partial<Billing> = {}): Billing => ({
  provider: "paymob", plan: "pro", status: "active", paidThrough: "2026-11-08", anchor: 8, autoRenew: true, failures: 0, txns: [], ...p,
});

describe("entitlements (rule 780)", () => {
  it("matches the old helpers for every plan and override", () => {
    const cases: EntUser[] = [
      user({ plan: "trial" }), user({ plan: "starter" }), user({ plan: "pro" }), user({ plan: "business" }),
      user({ plan: "agency" }), user({ plan: "agency", deal: { credits: 4000, priceSar: 2800, setAt: "x", setBy: "y" } }),
      user({ plan: "pro", seats: 9 }), user({ plan: "starter", chatAllowance: 0 }), user({ plan: "pro", chatAllowance: 900 }),
    ];
    for (const u of cases) {
      const e = entitlements(u, NOW);
      expect(e.credits.monthly).toBe(allowanceOf(u));
      expect(e.seats).toBe(seatLimit(u));
      expect(e.chat.monthly).toBe(chatAllowanceOf(u));
      expect({ hour: e.chat.hour, day: e.chat.day }).toEqual({ ...chatCaps(u) });
      expect(e.agents).toEqual(AGENT_IDS);
      expect(e.active).toBe(true);
    }
  });

  it("a trial includes the trial video models; a paid plan every video model", () => {
    expect(entitlements(user({ plan: "trial" }), NOW).media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(entitlements(user({ plan: "pro" }), NOW).media.video).toEqual(ALL_VIDEO_MODELS);
    expect(ALL_VIDEO_MODELS).toEqual(["vid-quick", "vid-sound", "vid-premium", "vid-cinematic", "vid-motion"]);
  });

  it("a video grant opens every model to a trial through the end of its day", () => {
    const u = user({ plan: "trial", grants: grant(day(0)) });
    expect(entitlements(u, NOW).media.video).toEqual(ALL_VIDEO_MODELS);
    expect(entitlements(u, Date.parse(`${day(0)}T23:59:59.999Z`)).media.video).toEqual(ALL_VIDEO_MODELS);
    expect(entitlements(u, Date.parse(`${day(1)}T00:00:00.000Z`)).media.video).toEqual(TRIAL_VIDEO_MODELS);
  });

  it("ignores an expired grant", () => {
    expect(entitlements(user({ plan: "trial", grants: grant(day(-1)) }), NOW).media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(grantActive(grant(day(-1)).video, NOW)).toBe(false);
    expect(grantActive(undefined, NOW)).toBe(false);
    expect(grantActive({ ...grant(day(3)).video, until: "not-a-day" }, NOW)).toBe(false);
    expect(grantActive({ ...grant(day(3)).video, by: "" }, NOW)).toBe(false);   // a grant needs by and at (spec 9)
    expect(grantActive({ ...grant(day(3)).video, at: "" }, NOW)).toBe(false);
    expect(grantActive(grant(day(3)).video, NOW)).toBe(true);
  });

  it("a stored grant dated with a day that does not exist reads as absent (ruling R8)", () => {
    // Date.parse rolls 2026-02-31 forward to 3 March, so a regex alone would keep this grant alive until then: asked
    // on 20 February it must already read as absent. The same stored grant with a real last day of the month is live.
    const feb20 = Date.parse("2026-02-20T00:00:00Z");
    expect(grantActive({ ...grant("2026-02-31").video }, feb20)).toBe(false);
    expect(grantActive({ ...grant("2026-02-28").video }, feb20)).toBe(true);
    expect(entitlements(user({ plan: "trial", trialEnds: "2026-03-20T00:00:00Z", grants: grant("2026-02-31") }), feb20).media.video).toEqual(TRIAL_VIDEO_MODELS);
  });

  it("isUtcDay: a YYYY-MM-DD day that exists, leap days included", () => {
    for (const s of ["2026-10-08", "2028-02-29", "2026-12-31", "0001-01-01"]) expect(isUtcDay(s), s).toBe(true);
    for (const s of ["2026-02-31", "2027-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "2026-1-9", "26-10-09", "2026-10-08T00:00:00Z", " 2026-10-08", "", "soon"]) expect(isUtcDay(s), s).toBe(false);
    expect(isUtcDay(20261008)).toBe(false);
    expect(isUtcDay(undefined)).toBe(false);
  });

  it("inactive: suspended, ended trial, locked Paymob subscription", () => {
    const suspended = user({ suspended: true });
    const ended = user({ plan: "trial", trialEnds: "2026-10-01T00:00:00Z" });
    const locked = user({ plan: "pro", billing: { ...billingFixture(), status: "locked", paidThrough: "2026-10-05" } });
    expect(entitlements(suspended, NOW)).toMatchObject({ active: false, inactive: "suspended" });
    expect(entitlements(ended, NOW)).toMatchObject({ active: false, inactive: "trial_over", endsAt: "2026-10-01T00:00:00Z" });
    expect(entitlements(locked, NOW)).toMatchObject({ active: false, inactive: "billing_locked", endsAt: "2026-10-05" });
    for (const u of [suspended, ended, locked]) {   // inactive accounts still report the plan's own numbers
      const e = entitlements(u, NOW);
      expect([e.credits.monthly, e.seats, e.chat.monthly]).toEqual([allowanceOf(u), seatLimit(u), chatAllowanceOf(u)]);
    }
  });

  it("endsAt: the trial end, the Paymob paid-through day, or null when activated by hand", () => {
    expect(entitlements(user({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z" }), NOW).endsAt).toBe("2026-10-20T00:00:00Z");
    expect(entitlements(user({ plan: "pro", billing: { ...billingFixture(), status: "active", paidThrough: "2026-11-08" } }), NOW).endsAt).toBe("2026-11-08");
    expect(entitlements(user({ plan: "pro" }), NOW).endsAt).toBeNull();
  });
});

/** A stored account, saved after `patch` is applied to it. */
async function stored(patch: Partial<User>): Promise<User> {
  const base = await newUser("view");
  const u = { ...(await getUser(base.email))!, ...patch };
  await saveUser(u);
  return u;
}

describe("entitlementView (rule 784)", () => {
  it("a trial with an expired grant: the plan's own list, the expired grant marked, use read from the store", async () => {
    const u = await stored({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z", credits: 37, grants: grant(day(-2)) });
    await db.set(chatTrialKey(u.email), 4);   // four chat messages used, so `used.chat` is not just the empty default
    const v = await entitlementView(u, NOW);
    expect(v.ent).toEqual(entitlements(u, NOW));
    expect(v.ent.media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(v.used.credits).toBe(37);
    expect(v.used.credits).toBe(u.credits);
    expect(v.used.seats).toBe(await seatsUsed(u.email));
    expect(v.used.chat).toEqual(await chatStatus(u));
    expect(v.used.chat.counted).toBe(4);
    expect(v.resetsAt).toBeNull();
    expect(v.grants.video).toEqual({ ...grant(day(-2)).video, expired: true });
  });

  it("an active grant is not marked expired, and no grant reads as null", async () => {
    const withGrant = await stored({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z", grants: grant(day(3)) });
    const without = await stored({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z" });
    const a = await entitlementView(withGrant, NOW);
    expect(a.grants.video).toEqual({ ...grant(day(3)).video, expired: false });
    expect(a.ent.media.video).toEqual(ALL_VIDEO_MODELS);
    expect((await entitlementView(without, NOW)).grants.video).toBeNull();
  });

  it("a grant dated with a day that does not exist is marked expired, like grantActive reads it", async () => {
    const u = await stored({ plan: "trial", trialEnds: "2026-03-20T00:00:00Z", grants: grant("2026-02-31") });
    const v = await entitlementView(u, Date.parse("2026-02-20T00:00:00Z"));
    expect(v.grants.video?.expired).toBe(true);
    expect(v.ent.media.video).toEqual(TRIAL_VIDEO_MODELS);
  });

  it("a paid plan resets on the next 1st of the month (a UTC day), the year rolling over in December", async () => {
    const u = await stored({ plan: "pro" });
    expect((await entitlementView(u, NOW)).resetsAt).toBe("2026-11-01");
    expect((await entitlementView(u, Date.parse("2026-12-15T10:00:00Z"))).resetsAt).toBe("2027-01-01");
    expect((await entitlementView(u, Date.parse("2026-10-31T23:59:59Z"))).resetsAt).toBe("2026-11-01");
    expect((await entitlementView(u, Date.parse("2026-11-01T00:00:00Z"))).resetsAt).toBe("2026-12-01");
    // Agency, with a deal, is paid too.
    const agency = await stored({ plan: "agency" });
    expect((await entitlementView(agency, NOW)).resetsAt).toBe("2026-11-01");
  });

  it("a locked Paymob subscription never renews (rule 712), so it has no reset; an active one does (ruling R3)", async () => {
    const active = await stored({ plan: "pro", billing: billingFixture({ status: "active" }) });
    const locked = await stored({ plan: "pro", billing: billingFixture({ status: "locked", paidThrough: "2026-10-05" }) });
    expect((await entitlementView(active, NOW)).resetsAt).toBe("2026-11-01");
    const v = await entitlementView(locked, NOW);
    expect(v.resetsAt).toBeNull();
    expect(v.ent).toMatchObject({ active: false, inactive: "billing_locked" });
  });

  it("is read-only: it writes nothing to the store", async () => {
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>> } }).__nashrMem;
    const snapshot = () => JSON.stringify([[...mem.kv], [...mem.lists], [...mem.sets].map(([k, v]) => [k, [...v]])]);
    const u = await stored({ plan: "pro", grants: grant(day(3)) });
    const before = snapshot();
    await entitlementView(u, NOW);
    expect(snapshot()).toBe(before);
  });
});

describe("EntitlementsTable (rule 784)", () => {
  const html = async (patch: Partial<User>, lang: "ar" | "en") => renderToStaticMarkup(createElement(EntitlementsTable, { view: await entitlementView(await stored(patch), NOW), lang }));
  const label = (id: string, lang: "ar" | "en") => MEDIA_MODELS.find((m) => m.id === id)!.label[lang];
  const trial = { plan: "trial" as const, trialEnds: "2026-10-20T00:00:00Z" };

  it("an expired grant is greyed and marked expired, and the video row falls back to the plan's list", async () => {
    for (const [lang, word] of [["en", "expired"], ["ar", "منتهية"]] as const) {
      const out = await html({ ...trial, grants: grant(day(-2)) }, lang);
      expect(out, lang).toContain('data-expired="true"');
      expect(out, lang).toContain(word);
      expect(out, lang).toContain(day(-2));
      expect(out, lang).toContain("opacity-60");
      const videoRow = out.slice(out.indexOf('data-row="video"'), out.indexOf('data-row="agents"'));
      for (const id of TRIAL_VIDEO_MODELS) expect(videoRow, `${lang} ${id}`).toContain(label(id, lang));
      expect(videoRow, lang).not.toContain(label("vid-cinematic", lang));
    }
  });

  it("a live grant shows its day, who set it and the note, not greyed, and every model as effective", async () => {
    const out = await html({ ...trial, grants: { video: { ...grant(day(3)).video, note: "agency demo" } } }, "en");
    expect(out).toContain('data-expired="false"');
    expect(out).not.toContain("opacity-60");
    expect(out).toContain(day(3));
    expect(out).toContain("founder@x");
    expect(out).toContain("agency demo");
    const videoRow = out.slice(out.indexOf('data-row="video"'), out.indexOf('data-row="agents"'));
    for (const m of MEDIA_MODELS.filter((x) => x.kind === "video")) expect(videoRow).toContain(m.label.en);
  });

  it("shows each dimension with its effective number and what is used, in both languages", async () => {
    for (const lang of ["en", "ar"] as const) {
      const u = await stored({ plan: "pro", credits: 123 });
      const v = await entitlementView(u, NOW);
      const out = renderToStaticMarkup(createElement(EntitlementsTable, { view: v, lang }));
      for (const key of ["credits", "seats", "chat", "rate", "video", "agents", "status"]) expect(out, `${lang} ${key}`).toContain(`data-row="${key}"`);
      expect(out).toContain(String(v.ent.credits.monthly));
      expect(out).toContain(`${v.used.seats} / ${v.ent.seats}`);
      expect(out).toContain(`${v.used.chat.counted} / ${v.used.chat.allowance}`);
      expect(out).toContain(`${v.ent.chat.hour} / ${v.ent.chat.day}`);
      expect(out).toContain("2026-11-01");   // the reset day
      expect(out).not.toContain('data-testid="video-grant"');
    }
  });

  it("an account that is not active says why", async () => {
    const locked = await html({ plan: "pro", billing: billingFixture({ status: "locked", paidThrough: "2026-10-05" }) }, "en");
    expect(locked).toContain("billing locked");
    expect(locked).toContain("2026-10-05");
    expect(await html({ plan: "pro", suspended: true }, "ar")).toContain("موقوف");
  });
});
