import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { decideProposal } from "@/lib/brand-proposals";
import { byOf } from "@/lib/actor";
import { recordActivity } from "@/lib/activity";

const decision = z.object({ action: z.enum(["apply", "dismiss"]) });

/**
 * The owner's answer to a brand change an agent proposed (src/lib/brand-proposals.ts): apply it or dismiss it. The same
 * role as the Brand page, since applying one writes the brand file; the proposal is read from the caller's own scope.
 * An applied proposal changed the brand file, so it is one `brand_changed` row of the activity log: by the login that
 * pressed Save (from the session), the proposing agent, and the field's name, never its value. A dismissal changes nothing
 * and writes no row.
 */
export const POST = handler<"user", typeof decision, undefined, { id: string }>(
  { auth: "user", role: "brand.write", input: decision, invalid: "bad_action" },
  async ({ u, scope, input: b, params: { id } }) => {
    const r = await decideProposal(scope, id, b.action);
    if (!r.ok) return NextResponse.json(r, { status: r.error === "not_found" ? 404 : 409 });
    if (r.applied) await recordActivity(scope, [{ at: r.brand?.updatedAt ?? new Date().toISOString(), kind: "brand_changed", agent: r.agent, by: byOf(u), via: "app", note: r.field }]);
    return NextResponse.json(r);
  },
);
