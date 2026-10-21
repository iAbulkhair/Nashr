import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { accountKey } from "@/lib/keys";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { BEATS_PER_HOUR, markSeen, pushLogin, pushOn } from "@/lib/push";

/**
 * POST /api/push/seen (rule 2564): a visible app tab of this login says "I am here", so no phone notification goes to
 * it for `AWAY_MINUTES`. Signed in first, a person's own session only, rate limited per login. Nothing in the body.
 */
export async function POST() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!pushOn()) return new NextResponse(null, { status: 204 });
  const login = pushLogin(u.actor);
  if (!login) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!(await allow(accountKey.seenBucket(login), BEATS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  await markSeen(login);
  return NextResponse.json({ ok: true });
}
