import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { normalizeEmail } from "./auth";
import { checkMfaCode, mfaActive } from "./mfa";
import { accountKey } from "./keys";
import type { Person } from "./person";
import { allow, giveBack, retryLater, WINDOW } from "./rate";

/** Wrong passwords per login and hour, shared with the two-step settings route (the same `mfapw:` bucket, rule 1170). */
const PASSWORD_TRIES_PER_HOUR = 10;
/** Longer than any password the sign-up rules accept; bcrypt reads 72 bytes, and a huge body is refused before hashing. */
const PASSWORD_MAX = 200;

/**
 * A fresh proof from the person themselves before an act that cannot be undone from the app (multi-workspace M3, rules
 * 2750 and 2754: offering the account's ownership, deleting one's login). Their own password, checked against the
 * PERSON's hash (never an account record's), rate limited on wrong ones only (`allow` before the compare, `giveBack`
 * after a right one); then, while two-step sign-in is on for the login, a fresh authenticator code (`checkMfaCode`,
 * rate limited per IP and login, a code used once never works twice). `recovery` says whether a recovery code may stand
 * in for the authenticator. A person without a password (a Google-only login) is refused `password_required`: there is
 * nothing fresh to prove. Null when the proof holds; otherwise the answer to return, with nothing written but the
 * counters.
 */
export async function freshProof(req: Request, p: Person, bornAt: string | undefined, input: { password?: unknown; code?: unknown }, opts: { recovery: boolean }): Promise<NextResponse | null> {
  if (!p.passHash) return NextResponse.json({ ok: false, error: "password_required" }, { status: 409 });
  const login = normalizeEmail(p.email);
  const bucket = accountKey.mfaPasswordBucket(login);
  if (!(await allow(bucket, PASSWORD_TRIES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const pw = input.password;
  if (typeof pw !== "string" || !pw || pw.length > PASSWORD_MAX || !(await bcrypt.compare(pw, p.passHash))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  await giveBack(bucket);
  if (await mfaActive(login, bornAt)) {
    const code = await checkMfaCode(req, login, bornAt, input.code, { recovery: opts.recovery });
    if (!code.ok) return code.res;
  }
  return null;
}
