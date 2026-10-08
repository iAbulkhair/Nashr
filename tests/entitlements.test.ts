import { describe, expect, it } from "vitest";
import { ALL_VIDEO_MODELS, entitlements, grantActive, isUtcDay, type EntUser } from "@/lib/entitlements";
import { AGENT_IDS } from "@/lib/agents";
import { allowanceOf, chatAllowanceOf, seatLimit } from "@/lib/pricing";
import { chatCaps } from "@/lib/rate";
import { TRIAL_VIDEO_MODELS } from "@/lib/media-catalog";
import type { Billing } from "@/lib/billing-state";

/**
 * Rule 780: `entitlements(u)` is the one place that says what an account's plan includes. It reads only the record and
 * constants, so these tests are pure: no db, no clock but the `now` they pass.
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
