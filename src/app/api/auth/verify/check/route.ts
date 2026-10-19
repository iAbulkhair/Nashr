import { NextResponse } from "next/server";
import { currentUserUnverified, emailVerified, getUser } from "@/lib/auth";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { checkVerifyCode, markVerified, normalizeCode } from "@/lib/verify-email";
import { acct } from "@/lib/account-id";

/**
 * Check the 6-digit code the owner typed (rule 761). The address is the session's, never one from the request. A member
 * login or an already verified owner answers ok (a double submit of the right code lands here). Input that is not six
 * digits after normalizing is refused without touching the code, so it does not use one of the five attempts. The
 * account is stamped only after `checkVerifyCode` answers ok.
 */
export async function POST(req: Request) {
  const u = await currentUserUnverified();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (u.actor?.kind === "member" || emailVerified(u)) return NextResponse.json({ ok: true });
  if (!(await allow(`verifycheck:ip:${clientIp(req)}`, 60, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as { code?: unknown };
  const typed = typeof b.code === "string" ? normalizeCode(b.code) : "";
  if (!/^\d{6}$/.test(typed)) return NextResponse.json({ ok: false, error: "wrong_code" }, { status: 400 });
  const r = await checkVerifyCode(u.email, typed);
  if (r.ok) {
    await markVerified(u.email);
    return NextResponse.json({ ok: true });
  }
  // A parallel submit of the right code may have won a moment ago and consumed it: the account is verified now, so ok.
  if (emailVerified((await getUser(acct(u))) ?? {})) return NextResponse.json({ ok: true });
  if (r.reason === "wrong") return NextResponse.json({ ok: false, error: "wrong_code", attemptsLeft: r.attemptsLeft }, { status: 400 });
  return NextResponse.json({ ok: false, error: r.reason }, { status: 400 });
}
