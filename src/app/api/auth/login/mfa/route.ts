import { NextResponse } from "next/server";
import { getLogin } from "@/lib/auth";
import { bornAt, finishAnswer, finishLogin } from "@/lib/login-finish";
import { checkMfaCode, failChallenge, readChallenge, takeChallenge } from "@/lib/mfa";
import { allow, clientIp, retryLater } from "@/lib/rate";

/**
 * POST {code}: the second step of signing in (rule 1934). Public, like the log-in route, and throttled by the same
 * per-IP and per-login buckets plus the code's own tries (src/lib/mfa.ts). The login is the one the challenge cookie
 * points at, kept server side; the request never names it.
 *
 * The code is the authenticator's 6 digits or one recovery code. A wrong code counts on the challenge, and the fifth
 * drops it (the password must be typed again). A right one spends the challenge (single use), then every login refusal
 * runs again (an account suspended or a member paused in the minutes between) before the session is created.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const open = await readChallenge();
  if (!open) return NextResponse.json({ ok: false, error: "mfa_expired" }, { status: 401 });
  const { id, ch } = open;
  if (!(await allow(`login:ip:${clientIp(req)}`, 20, 900)) || !(await allow(`login:em:${ch.email}`, 8, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const login = await getLogin(ch.email);
  if (!login) {
    await takeChallenge(id);
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
  }
  const checked = await checkMfaCode(req, ch.email, bornAt(login), b.code);
  if (!checked.ok) {
    if (checked.res.status === 400) await failChallenge(id, ch);
    return checked.res;
  }
  // Single use: of two requests carrying the same right code, only the one that takes the challenge signs in.
  if (!(await takeChallenge(id))) return NextResponse.json({ ok: false, error: "mfa_expired" }, { status: 401 });
  const done = await finishLogin(login, { via: ch.via, codeDone: true });
  if (done.kind !== "signed_in") return finishAnswer(done);
  return NextResponse.json({
    ok: true,
    ...(done.verify === undefined ? {} : { verify: done.verify }),
    ...(ch.next ? { next: ch.next } : {}),
    ...(checked.via === "recovery" ? { recoveryLeft: checked.left } : {}),
  });
}
