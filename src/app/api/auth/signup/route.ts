import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { createSession, createUser, getUser, normalizeEmail, strongPassword, validEmail } from "@/lib/auth";
import { allow, clientIp } from "@/lib/rate";
import { applyReferral, registerCode } from "@/lib/referral";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const email = normalizeEmail(b.email ?? "");
  // Every account gets trial credits and a free onboarding run, so account creation is throttled per IP.
  if (!(await allow(`signup:ip:${clientIp(req)}`, 5, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  if (!validEmail(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (!strongPassword(b.password ?? "")) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  // Phone is optional at signup (asked later inside onboarding); validate only when given.
  if (b.phone && b.phone.replace(/\D/g, "").length < 9) return NextResponse.json({ ok: false, error: "bad_phone" }, { status: 400 });
  if (await getUser(email)) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  const u = await createUser({ email, name: b.name ?? "", phone: b.phone ?? "", password: b.password, lang: b.lang === "en" ? "en" : "ar" });
  await registerCode(u.email);
  let referred = false;
  if (b.ref && /^[A-Za-z0-9]{6,10}$/.test(b.ref)) referred = await applyReferral(u.email, b.ref);
  await createSession(u.email);
  await track(u.email, "signup");
  return NextResponse.json({ ok: true, referred });
}
