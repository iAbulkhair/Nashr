import { NextResponse } from "next/server";
import { currentUserUnverified, emailVerified } from "@/lib/auth";
import { isProductionDeploy } from "@/lib/deploy-env";
import { mailReady, sendEmail } from "@/lib/notify";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { issueVerifyCode, VERIFY, verifyMail } from "@/lib/verify-email";
import { db } from "@/lib/db";

/**
 * Mail a fresh 6-digit code to the signed-in owner (rules 759-760, 766). The address is the session's, never one from the
 * request. A member login or an already verified owner has nothing to prove (409). Three buckets, checked in order, the
 * refusing one names the wait: one send a minute, five an hour per address, twenty an hour per IP. The code is never in a
 * response, except as `devCode` on a test deploy (`APP_ENV=test` and not a production deploy).
 */
export async function POST(req: Request) {
  const u = await currentUserUnverified();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (u.actor?.kind === "member" || emailVerified(u)) return NextResponse.json({ ok: false, error: "already_verified" }, { status: 409 });
  if (!mailReady()) return NextResponse.json({ ok: false, error: "mail_unavailable" }, { status: 503 });
  if (!(await allow(`verify:gap:${u.email}`, 1, VERIFY.gap))) return retryLater({ ok: false, error: "slow_down" }, VERIFY.gap);
  if (!(await allow(`verify:hour:${u.email}`, VERIFY.perHour, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  if (!(await allow(`verify:ip:${clientIp(req)}`, VERIFY.perIpHour, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const code = await issueVerifyCode(u.email);
  const m = verifyMail(u, code);
  if (!(await sendEmail(u.email, m.subject, m.text))) {
    // The code never reached the owner: drop it so a code nobody has seen is not left to guess against.
    await db.del(`verify:code:${u.email}`);
    return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
  }
  const exposeCode = process.env.APP_ENV === "test" && !isProductionDeploy();
  return NextResponse.json({ ok: true, resendIn: VERIFY.gap, ...(exposeCode ? { devCode: code } : {}) });
}
