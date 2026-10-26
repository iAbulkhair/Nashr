import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, handler } from "@/lib/api-handler";
import { sc } from "@/lib/auth";
import { WINDOW } from "@/lib/rate";
import { decideResearch, getResearch, isResearchId, researchCard } from "@/lib/research";
import { v2On } from "@/lib/v2-switch";

const action = z.object({ action: z.enum(["approve", "dismiss"]) });

/**
 * One web search an agent asked for, as its chat card shows it (Thakeen v2 phase 4, C10, rules 4802-4805): GET the card,
 * POST `{ action: "approve" | "dismiss" }`. 404 while `RESEARCH` is off, as if the route did not exist.
 *
 * Read only from the caller's own scope (`sc(u)`): the id is checked against its format before a key is built, another
 * account's or brand's id is 404, and no body field names a scope, a query, an agent or a price. Every login reads it
 * (`read`); approving lets a search spend credits, so it needs `generate`, like Run on a spend card. Approve runs nothing
 * here: it puts the id on the thread, and the agent's next turn runs the stored query and charges for it
 * (`takeApproved`). 409 `decided` once the card was answered.
 */
export const GET = handler<"user", undefined, undefined, { id: string }>(
  { auth: "user", role: "read", rate: { bucket: "researchread", max: 300, window: WINDOW.hour, per: "scope" } },
  async ({ u, params: { id } }) => {
    if (!v2On("RESEARCH") || !isResearchId(id)) return fail("not_found", 404);
    const p = await getResearch(sc(u), id);
    if (!p) return fail("not_found", 404);
    return NextResponse.json({ ok: true, research: researchCard(p) });
  },
);

export const POST = handler<"user", typeof action, undefined, { id: string }>(
  {
    auth: "user",
    role: "generate",
    rate: { bucket: "researchact", max: 60, window: WINDOW.hour, per: "scope" },
    input: action,
    invalid: "bad_action",
  },
  async ({ u, input: b, params: { id } }) => {
    if (!v2On("RESEARCH") || !isResearchId(id)) return fail("not_found", 404);
    const r = await decideResearch(sc(u), id, b.action);
    if (!r.ok) return NextResponse.json(r, { status: r.error === "not_found" ? 404 : 409 });
    return NextResponse.json({ ok: true, research: researchCard(r.p) });
  },
);
