import { NextResponse } from "next/server";
import { createSession, currentUserUnverified, destroySession, normalizeEmail, validEmail } from "@/lib/auth";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { devCodeExposed, moveUnverifiedAccount, secondsToUtcMidnight, sendVerifyCode, verifySendRefusal } from "@/lib/verify-email";

/**
 * Correct a mistyped signup address before it is verified (rules 763-765, 766). The account moved is always the session's
 * own; the only thing taken from the body is the new address. Only an owner of a gated signup who has not verified may call
 * it (403 `not_allowed`), to an address nobody holds (409 `exists`, 400 `same_email` for the one it already has), three
 * times a UTC day (429). On success the old session ends, a session for the new address starts, and a fresh code goes to
 * the new address through the same refusals and buckets as the send route. The account has moved by then, so a code that
 * cannot be sent (mail off, a bucket full, the provider refused) still answers 200 with `mail: false`: the verify page
 * offers a resend. Only a test deploy returns the code (`devCode`).
 */
export async function POST(req: Request) {
  const u = await currentUserUnverified();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (u.actor?.kind !== "owner") return NextResponse.json({ ok: false, error: "not_allowed" }, { status: 403 });
  if (!(await allow(`verifymove:ip:${clientIp(req)}`, 20, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as { email?: unknown };
  const to = normalizeEmail(typeof b.email === "string" ? b.email : "");
  if (!validEmail(to)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (to === u.email) return NextResponse.json({ ok: false, error: "same_email" }, { status: 400 });
  // Every attempt counts, taken or not: the 409 `exists` answer is otherwise an address oracle for a long-lived session.
  if (!(await allow(`verifymove:acct:${u.email}`, 10, 86400))) return retryLater({ ok: false, error: "slow_down" }, 86400);
  const r = await moveUnverifiedAccount(u, to);
  if (r === "not_allowed") return NextResponse.json({ ok: false, error: "not_allowed" }, { status: 403 });
  if (r === "exists") return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  if (r === "limit") return retryLater({ ok: false, error: "slow_down" }, secondsToUtcMidnight());
  await destroySession();
  await createSession(to);
  const expose = devCodeExposed();
  let mail = false;
  let devCode: string | undefined;
  if (!(await verifySendRefusal(to, req))) {
    try {
      const sent = await sendVerifyCode({ email: to, lang: u.lang });
      mail = sent.sent;
      if (expose) devCode = sent.code;
    } catch (e) {
      console.error("verify code failed", e instanceof Error ? e.name : "error");
    }
  }
  return NextResponse.json({ ok: true, email: to, ...(mail ? {} : { mail: false }), ...(devCode ? { devCode } : {}) });
}
