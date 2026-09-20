import { describe, expect, it } from "vitest";
import { lifecyclePlan } from "@/lib/lifecycle";
import { ranThisWeek, weekStartUtc } from "@/lib/schedule";

const iso = (s: string) => new Date(s).getTime();
const due = (plan: [string, boolean][]) => plan.filter(([, d]) => d).map(([k]) => k);

/**
 * The daily cron fires at 05:00 UTC. A trial is three days from the signup moment, so for anyone who did not sign up
 * at 05:00 the elapsed-days gate put the trial emails on the wrong side of the deadline.
 */
describe("trial emails land before the trial ends, not after", () => {
  const user = { createdAt: "2026-09-01T10:00:00.000Z", trialEnds: "2026-09-04T10:00:00.000Z", plan: "trial" as const };

  it("'ends tomorrow' is sent while more than a day is left", () => {
    // Cron on 3 Sep 05:00 — 29 hours left.
    expect(due(lifecyclePlan(user, iso("2026-09-03T05:00:00.000Z")))).toContain("day2");
    expect(due(lifecyclePlan(user, iso("2026-09-03T05:00:00.000Z")))).not.toContain("day3");
  });

  it("'last day' is sent on the last day, not after the trial is over", () => {
    // Cron on 4 Sep 05:00 — 5 hours left. This is the day the trial actually dies.
    const onExpiryDay = due(lifecyclePlan(user, iso("2026-09-04T05:00:00.000Z")));
    expect(onExpiryDay).toContain("day3");
    expect(onExpiryDay).not.toContain("day2");
  });

  it("neither deadline note is sent once the trial has already ended", () => {
    // Cron on 5 Sep 05:00 — the trial died 19 hours ago. The old gate sent "today is your last day" here.
    const afterwards = due(lifecyclePlan(user, iso("2026-09-05T05:00:00.000Z")));
    expect(afterwards).not.toContain("day2");
    expect(afterwards).not.toContain("day3");
  });

  it("holds for every signup hour, which is what the elapsed-days gate could not do", () => {
    for (let hour = 0; hour < 24; hour++) {
      const h = String(hour).padStart(2, "0");
      const u = { createdAt: `2026-09-01T${h}:00:00.000Z`, trialEnds: `2026-09-04T${h}:00:00.000Z`, plan: "trial" as const };
      for (let day = 1; day <= 6; day++) {
        const now = iso(`2026-09-0${day}T05:00:00.000Z`);
        const keys = due(lifecyclePlan(u, now));
        const hoursLeft = (iso(u.trialEnds) - now) / 36e5;
        if (keys.includes("day3")) expect(hoursLeft, `signup ${h}:00, day ${day}`).toBeGreaterThan(0);
        if (keys.includes("day2")) expect(hoursLeft, `signup ${h}:00, day ${day}`).toBeGreaterThan(24);
      }
    }
  });

  it("a paying account gets neither", () => {
    const paid = { ...user, plan: "pro" as const };
    const keys = due(lifecyclePlan(paid, iso("2026-09-04T05:00:00.000Z")));
    expect(keys).not.toContain("day2");
    expect(keys).not.toContain("day3");
  });
});

describe("a manual run does not cancel the next week's plan", () => {
  it("the week starts on Sunday, in UTC", () => {
    expect(weekStartUtc(new Date("2026-09-27T03:00:00.000Z"))).toBe("2026-09-27"); // a Sunday
    expect(weekStartUtc(new Date("2026-09-23T12:00:00.000Z"))).toBe("2026-09-20"); // the Wednesday before
  });

  it("Wednesday's manual run does not block the following Sunday", () => {
    // The rolling five-day window refused this, and the cron marker then recorded the week as already done.
    expect(ranThisWeek("2026-09-23T12:00:00.000Z", new Date("2026-09-27T03:00:00.000Z"))).toBe(false);
  });

  it("a Tuesday catch-up does not block the next Sunday either", () => {
    expect(ranThisWeek("2026-09-22T05:00:00.000Z", new Date("2026-09-27T03:00:00.000Z"))).toBe(false);
  });

  it("but a second run inside the same week is still refused", () => {
    expect(ranThisWeek("2026-09-27T03:00:00.000Z", new Date("2026-09-27T09:00:00.000Z"))).toBe(true);
    expect(ranThisWeek("2026-09-27T03:00:00.000Z", new Date("2026-10-01T05:00:00.000Z"))).toBe(true);
  });

  it("never ran is never blocked", () => {
    expect(ranThisWeek(undefined, new Date("2026-09-27T03:00:00.000Z"))).toBe(false);
  });
});
