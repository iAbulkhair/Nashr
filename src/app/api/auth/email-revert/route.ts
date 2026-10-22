import { NextResponse } from "next/server";
import { revertEmailMove } from "@/lib/email-move";
import { globalKey } from "@/lib/keys";
import { isPersonLockTimeout } from "@/lib/person";
import { allow, clientIp, retryLater } from "@/lib/rate";

/** Revert attempts per IP per 15 minutes (as the reset route). */
const TRIES_PER_IP = 10;

/**
 * POST {token} → undo a sign-in address move (account-id R2, decision D1, rule 2744). The token is the single-use link
 * mailed to the OLD address when the move happened (`emailrevert:{sha256}`, 7 days); it is the only credential, as a
 * reset link is. The person moves back in place, every session ends, the password becomes unknown, and two-step,
 * passkeys and the Google link added after the move go. The answer is a one-hour reset token for the old address
 * (`{ok, reset}`), which the reset page uses at once to set a new password. Refused unless `OPAQUE_IDS` is on (no token
 * exists before). Rate limited per IP; a bad, used or expired token is 400 `bad_token`.
 */
export async function POST(req: Request) {
  if (!(await allow(globalKey.emailRevertIpBucket(clientIp(req)), TRIES_PER_IP, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const b = (await req.json().catch(() => ({}))) as { token?: unknown };
  try {
    const r = await revertEmailMove(b.token);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "bad_token" ? 400 : 409 });
    return NextResponse.json({ ok: true, reset: r.reset });
  } catch (e) {
    if (isPersonLockTimeout(e) || (e instanceof Error && e.message === "user_lock_timeout")) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
}
