import { NextResponse } from "next/server";
import { z } from "zod";
import { byOf } from "@/lib/actor";
import { fail, handler } from "@/lib/api-handler";
import { sc } from "@/lib/auth";
import { cancelPlan, getPlan, isPlanId, pausePlan, planView, resumePlan } from "@/lib/plans";
import { approvePlan } from "@/lib/plan-run";
import { WINDOW } from "@/lib/rate";
import { PLANS } from "@/lib/v2-flags";

const action = z.object({ action: z.enum(["approve", "pause", "resume", "cancel"]) });

const STATUS: Record<string, number> = { not_found: 404, expired: 410, no_credits: 402 };

/**
 * One of Majed's plans as its chat card shows it (Thakeen v2 phase 2, C3, rules 4628-4631): GET the plan, POST
 * `{ action: "approve" | "pause" | "resume" | "cancel" }`. 404 while `PLANS` is off, as if the route did not exist.
 *
 * The plan is read only from the caller's own scope (`sc(u)`): the id is checked against its format before any key is
 * built, an id of another account or brand is 404, and no body field names a scope, a step or a cost. Every login of the
 * account may read it (`read`); acting on it spends credits, so it needs `generate`, like Run on a handoff. Approve is the
 * only approval there is: `make_plan` stored a proposal and ran nothing, and the checks behind it (fresh balance, agent
 * caps, the proposal's age) are in code (`approvePlan`). Who approved comes from the session (`byOf`).
 */
export const GET = handler<"user", undefined, undefined, { id: string }>(
  { auth: "user", role: "read", rate: { bucket: "planread", max: 300, window: WINDOW.hour, per: "scope" } },
  async ({ u, params: { id } }) => {
    if (!PLANS || !isPlanId(id)) return fail("not_found", 404);
    const p = await getPlan(sc(u), id);
    if (!p) return fail("not_found", 404);
    return NextResponse.json({ ok: true, plan: planView(p) });
  },
);

export const POST = handler<"user", typeof action, undefined, { id: string }>(
  {
    auth: "user",
    role: "generate",
    rate: { bucket: "planact", max: 60, window: WINDOW.hour, per: "scope" },
    input: action,
    invalid: "bad_action",
  },
  async ({ u, input: b, params: { id } }) => {
    if (!PLANS || !isPlanId(id)) return fail("not_found", 404);
    const s = sc(u);
    const r =
      b.action === "approve"
        ? await approvePlan(u, id, byOf(u))
        : b.action === "pause"
          ? await pausePlan(s, id)
          : b.action === "resume"
            ? await resumePlan(s, id)
            : await cancelPlan(s, id);
    if (!r.ok) return NextResponse.json(r, { status: STATUS[r.error] ?? 409 });
    return NextResponse.json({ ok: true, plan: planView(r.plan) });
  },
);
