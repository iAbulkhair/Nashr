import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { allow } from "@/lib/rate";
import { setVote, votableId } from "@/lib/wishlist";

/** Votes per account per hour: far above what a person clicks, low enough that a script cannot churn the counts. */
const VOTES_PER_HOUR = 60;

/**
 * POST {id, on?} — vote for a wishlist item (on: true), take the vote back (on: false), or toggle (no `on`).
 * Signed-in accounts only. The voter is the session's account: an email, scope or user in the body is ignored.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  if (!(await allow(`wishvote:${u.email}`, VOTES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; on?: unknown };
  const id = await votableId(b.id);
  if (!id) return NextResponse.json({ ok: false, error: "unknown_item" }, { status: 400 });
  const r = await setVote(u.email, id, typeof b.on === "boolean" ? b.on : undefined);
  return NextResponse.json({ ok: true, id, ...r });
}
