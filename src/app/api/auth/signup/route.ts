import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { afterSignup, signupPartner } from "@/lib/partners";
import { createSession, createUser, getLogin, normalizeEmail, strongPassword, validEmail } from "@/lib/auth";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { countVerifySend, devCodeExposed, sendVerifyCode } from "@/lib/verify-email";
import { applyReferral, registerCode } from "@/lib/referral";
import { captchaRefusal } from "@/lib/turnstile";
import { getMember, withLoginLock } from "@/lib/team";
import { addressBlocked } from "@/lib/email-hold";
import { acct } from "@/lib/account-id";
import { isPersonLockTimeout } from "@/lib/person";
import { passwordSignupAllowed } from "@/lib/signup-mode";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
  // Every account gets trial credits and a free onboarding run, so account creation is throttled per IP.
  if (!(await allow(`signup:ip:${clientIp(req)}`, 5, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  if (!validEmail(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (!strongPassword(typeof b.password === "string" ? b.password : "")) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  // Phone is optional at signup (asked later inside onboarding); validate only when given.
  if (b.phone && String(b.phone).replace(/\D/g, "").length < 9) return NextResponse.json({ ok: false, error: "bad_phone" }, { status: 400 });
  // Cloudflare Turnstile when both keys are set (src/lib/turnstile.ts): checked before the address is looked up, so a
  // script can neither create accounts nor learn which addresses exist without passing it. Rule 426.
  const refused = await captchaRefusal(req, b.turnstile);
  if (refused) return refused;
  // Invite-only sign-up (src/lib/signup-mode.ts, rules 3521, 3524): with `SIGNUP_MODE=invite` a new login needs the invite
  // link's token for this address. Checked after Turnstile and before the address is looked up, so the refusal is the
  // same whether or not the address has a login, and the rate limit above already counted the attempt.
  if (!(await passwordSignupAllowed(email, b.invite))) return NextResponse.json({ ok: false, error: "invite_only" }, { status: 403 });
  // Partner programme (src/lib/partners.ts, rule 392): a typed partner code must be a partner's, checked before anything
  // is created and after Turnstile, so a script cannot probe which codes exist without passing it; without a typed code,
  // the code in the 30-day link cookie, if it is still a partner's.
  const partner = await signupPartner(b.partnerCode);
  if (partner === "bad") return NextResponse.json({ ok: false, error: "bad_partner_code" }, { status: 400 });
  // An email is ONE login across owner accounts and member logins (docs/superpowers/specs/2026-09-29-teams-design.md §3).
  // Checked and created under the same lock invite acceptance takes, so a signup and an accept racing on one address
  // cannot both succeed. A member's address gets the same answer as an existing account.
  // `createUser` writes the person under `lock:person` (rule 2139): a lock held past the wait wrote nothing, 409 `busy`.
  let account: Awaited<ReturnType<typeof createUser>> | null;
  try {
    account = await withLoginLock(email, async () => {
      // A member record that is not a login (off its roster, or a stale copy) still holds the address, as in Google sign-in.
      // Account-id R2 (rule 2743): an address another person moved away from in place is held for 30 days (only a move
      // in place writes a hold). The same answer as an existing account.
      const [login, member, blocked] = await Promise.all([getLogin(email), getMember(email), addressBlocked(email)]);
      if (login || member || blocked === "held") return null;
      return createUser({ email, name: String(b.name ?? ""), phone: String(b.phone ?? ""), password: b.password, lang: b.lang === "en" ? "en" : "ar" });
    });
  } catch (e) {
    if (isPersonLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
  if (!account) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  await registerCode(acct(account));
  let referred = false;
  if (b.ref && /^[A-Za-z0-9]{6,10}$/.test(b.ref)) referred = await applyReferral(acct(account), b.ref);
  // The account exists by now: a failed attribution is logged, never turned into a failed signup.
  const partnered = await afterSignup(account, partner).catch((e) => { console.error("partner attribution failed", e instanceof Error ? e.message : "error"); return false; });
  await createSession(account.email);
  await track(acct(account), "signup");
  // The first verification code (rule 762). The account exists and is signed in by now, so a mail that cannot go out
  // never fails the signup: `mail: false` tells the verify page to offer a resend. Rule 766: `devCode` only on a test deploy.
  let mail = false;
  let devCode: string | undefined;
  try {
    const r = await sendVerifyCode(account);
    mail = r.sent;
    // A mail that went out counts in the address buckets of the send route (rule 759): a resend right after signup waits
    // its minute. One that did not is not counted, so the verify page's own first send goes through.
    if (r.sent) await countVerifySend(account.email);
    if (devCodeExposed()) devCode = r.code;
  } catch (e) {
    console.error("verify code failed", e instanceof Error ? e.name : "error");
  }
  return NextResponse.json({ ok: true, referred, partner: partnered, verify: true, mail, ...(devCode ? { devCode } : {}) });
}
