import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { WINDOW } from "@/lib/rate";
import { setVote, votableId } from "@/lib/wishlist";

/** Votes per account per hour: far above what a person clicks, low enough that a script cannot churn the counts. */
const VOTES_PER_HOUR = 60;

/** `id` is checked against the published items by `votableId`; an `on` that is not a boolean is a toggle. */
const voteBody = z.looseObject({ id: z.unknown(), on: z.boolean().optional().catch(undefined) });

/**
 * POST {id, on?} — vote for a wishlist item (on: true), take the vote back (on: false), or toggle (no `on`).
 * Signed-in accounts only. The voter is the session's account: an email, scope or user in the body is ignored.
 */
export const POST = handler(
  { auth: "user", unauthorized: "auth", rate: { bucket: "wishvote", max: VOTES_PER_HOUR, window: WINDOW.hour }, input: voteBody, invalid: "unknown_item" },
  async ({ u, input: b }) => {
    const id = await votableId(b.id);
    if (!id) return NextResponse.json({ ok: false, error: "unknown_item" }, { status: 400 });
    const r = await setVote(u.email, id, b.on);
    return NextResponse.json({ ok: true, id, ...r });
  },
);
