import { describe, expect, it } from "vitest";
import { newOpaqueUser, newUser } from "./helpers/session";
import { acct } from "@/lib/account-id";
import { getUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { chargeOnce } from "@/lib/credits";
import { periodOf, routineClaim } from "@/lib/routines";
import { createHandoff, handoffClaim } from "@/lib/handoffs";
import { systemBy } from "@/lib/actor";
import { TASK_COST } from "@/lib/tasks";
import { lostCharges } from "../scripts/lost-scheduled-charges";

/**
 * Rule 2486: the founder's read-only list of scheduled charges lost before the claim-and-receipt release (founder decision
 * 2026-10-20: refund by hand, no scan that writes). A period's unsettled routine charges, less the one its recorded run
 * delivered, and a handoff item left running past its lock; anything the new release's sweep handles (a receipt or a claim
 * hold) is never listed, so it cannot be refunded twice.
 */
const mem = () => (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem;

describe("rule 2486: the lost scheduled charges list", () => {
  it("lists undelivered routine charges and stale running handoff items, skips what the sweep handles, and writes nothing", async () => {
    const u = await newUser("lost");
    const id = acct(u);
    const week = periodOf("weekly");
    // Dana: two charges this week, nothing delivered.
    await db.set(`routinetry:${id}:dana_weekly_report:${week}`, 2);
    // Noor: one charge, and its run was recorded this week: delivered.
    await db.set(`routinetry:${id}:noor_cart_recovery:${week}`, 1);
    await db.set(`routinelast:${id}:noor_cart_recovery`, new Date().toISOString());
    // Razan: unsettled, but the new release holds it (a claim hold): the sweep's, not the founder's.
    const month = periodOf("monthly");
    await db.set(`routinetry:${id}:razan_cash_forecast:${month}`, 1);
    await chargeOnce(id, 1, { scope: id, agent: "razan" }, routineClaim(id, "razan_cash_forecast", month));
    // Majed: unsettled, with a receipt of the new release.
    await db.set(`routinetry:${id}:majed_monthly_review:${month}`, 1);
    await db.set(`runrec:${routineClaim(id, "majed_monthly_review", month)}`, { state: "held", at: new Date().toISOString() });
    // A handoff: item 0 left running an hour ago; item 1 running but held by the new release.
    const h = await createHandoff(id, { proposal: { items: [{ type: "sales_script", brief: "b" }, { type: "prd", brief: "c" }] }, requestedBy: systemBy("cron"), origin: "web_chat", ownerMsg: "m" });
    const raw = (await db.get<{ items: Record<string, unknown>[] }>(`handoff:${id}:${h.id}`))!;
    const old = new Date(Date.now() - 3600e3).toISOString();
    await db.set(`handoff:${id}:${h.id}`, { ...raw, items: raw.items.map((it) => ({ ...it, status: "running", at: old })) });
    await chargeOnce(id, 1, { scope: id, agent: "layan" }, handoffClaim(id, h.id, 1));

    const before = JSON.stringify([...mem().kv.entries()]);
    const rows = (await lostCharges()).filter((r) => r.account === u.email);
    expect(JSON.stringify([...mem().kv.entries()]), "read only").toBe(before);
    expect(rows).toEqual([
      { account: u.email, scope: id, kind: "routine", what: "dana_weekly_report", period: week, charges: 2, credits: TASK_COST.weekly_report, sure: true },
      { account: u.email, scope: id, kind: "handoff", what: `${h.id}#0:sales_script`, period: old.slice(0, 10), charges: 1, credits: TASK_COST.sales_script, sure: false },
    ]);
    expect((await getUser(id))!.paidOnce, "holds untouched").toBeTruthy();
  });

  it("finds an account with an opaque id by that id, not by its address (rule 1980)", async () => {
    const o = await newOpaqueUser("lost-opaque");
    const id = acct(o);
    const week = periodOf("weekly");
    await db.set(`routinetry:${id}:dana_weekly_report:${week}`, 1);
    const rows = (await lostCharges()).filter((r) => r.account === o.email);
    expect(rows).toEqual([{ account: o.email, scope: id, kind: "routine", what: "dana_weekly_report", period: week, charges: 1, credits: TASK_COST.weekly_report, sure: true }]);
  });
});
