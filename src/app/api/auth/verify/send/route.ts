import { NextResponse } from "next/server";
import { currentUserUnverified, emailVerified } from "@/lib/auth";
import { devCodeExposed, sendVerifyCode, verifySendRefusal, VERIFY } from "@/lib/verify-email";

/**
 * Mail a fresh 6-digit code to the signed-in owner (rules 759-760, 766). The address is the session's, never one from the
 * request. A member login or an already verified owner has nothing to prove (409). Three buckets, checked in order, the
 * refusing one names the wait: one send a minute, five an hour per address, twenty an hour per IP. The code is never in a
 * response, except as `devCode` on a test deploy (`devCodeExposed`), where mail may be off or refused and the code is
 * returned anyway.
 */
export async function POST(req: Request) {
  const u = await currentUserUnverified();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (u.actor?.kind === "member" || emailVerified(u)) return NextResponse.json({ ok: false, error: "already_verified" }, { status: 409 });
  const expose = devCodeExposed();
  const refused = await verifySendRefusal(u.email, req);
  if (refused) return refused;
  const { sent, code } = await sendVerifyCode(u);
  if (!sent && !expose) return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
  return NextResponse.json({ ok: true, resendIn: VERIFY.gap, ...(expose ? { devCode: code } : {}) });
}
