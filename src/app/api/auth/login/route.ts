import { NextResponse } from "next/server";
import { getLogin, normalizeEmail, verifyPassword } from "@/lib/auth";
import { finishAnswer, finishLogin } from "@/lib/login-finish";
import { allow, clientIp, retryLater } from "@/lib/rate";

/**
 * POST {email, password}. An email signs in as whatever login it is (src/lib/auth.ts `getLogin`): an owner account or a
 * member of one. The password is checked against THAT login's person (`login.person`, multi-workspace M1: the person as
 * `getPerson` reads it, so a stale `person:` row never beats a newer legacy record), so an owner's password never opens
 * a member login and a member's never opens the owner's. The session is issued for the login email; `currentUser` resolves a
 * member session to the owner's account on every request.
 *
 * An owner who has not proved the address yet still gets a session, and the answer says `verify: true`: the form then
 * goes to the verify page with the destination in `next`, so a destination outside `/[lang]/app` (the OAuth consent
 * page) cannot loop back to login (rule 754). A member of such an owner gets no session at all (rule 767).
 *
 * A login with two-step sign-in on (src/lib/mfa.ts) gets no session from the password alone: the answer is
 * `{ok: false, error: "mfa_required", mfa: true}` with a short-lived challenge cookie, and the code goes to
 * POST /api/auth/login/mfa (rule 1934).
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
  const password = typeof b.password === "string" ? b.password : "";
  // Credential stuffing and password guessing: throttle per IP and per targeted login.
  if (!(await allow(`login:ip:${clientIp(req)}`, 20, 900)) || !(await allow(`login:em:${email}`, 8, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const login = email ? await getLogin(email) : null;
  if (!login || !(await verifyPassword(login.person, password))) return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });

  // The account checks, the two-step challenge (rule 1934) and the session, shared with the Google sign-in and the code
  // step: src/lib/login-finish.ts.
  return finishAnswer(await finishLogin(login!, { via: "password" }));
}
