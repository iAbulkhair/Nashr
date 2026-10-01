import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { createSession, createUser, getLogin, normalizeEmail, strongPassword, validEmail } from "@/lib/auth";
import { allow, clientIp } from "@/lib/rate";
import { applyReferral, registerCode } from "@/lib/referral";
import { captchaRefusal } from "@/lib/turnstile";
import { withLoginLock } from "@/lib/team";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
  // Every account gets trial credits and a free onboarding run, so account creation is throttled per IP.
  if (!(await allow(`signup:ip:${clientIp(req)}`, 5, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  if (!validEmail(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (!strongPassword(typeof b.password === "string" ? b.password : "")) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  // Phone is optional at signup (asked later inside onboarding); validate only when given.
  if (b.phone && String(b.phone).replace(/\D/g, "").length < 9) return NextResponse.json({ ok: false, error: "bad_phone" }, { status: 400 });
  // Cloudflare Turnstile when both keys are set (src/lib/turnstile.ts): checked before the address is looked up, so a
  // script can neither create accounts nor learn which addresses exist without passing it. Rule 316.
  const refused = await captchaRefusal(req, b.turnstile);
  if (refused) return refused;
  // An email is ONE login across owner accounts and member logins (docs/superpowers/specs/2026-09-29-teams-design.md §3).
  // Checked and created under the same lock invite acceptance takes, so a signup and an accept racing on one address
  // cannot both succeed. A member's address gets the same answer as an existing account.
  const account = await withLoginLock(email, async () => {
    if (await getLogin(email)) return null;
    return createUser({ email, name: String(b.name ?? ""), phone: String(b.phone ?? ""), password: b.password, lang: b.lang === "en" ? "en" : "ar" });
  });
  if (!account) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  await registerCode(account.email);
  let referred = false;
  if (b.ref && /^[A-Za-z0-9]{6,10}$/.test(b.ref)) referred = await applyReferral(account.email, b.ref);
  await createSession(account.email);
  await track(account.email, "signup");
  return NextResponse.json({ ok: true, referred });
}
