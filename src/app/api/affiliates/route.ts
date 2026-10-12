import { NextResponse } from "next/server";
import { CAPS, db, pushCapped } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { APPLICATIONS, newId, type Application } from "@/lib/partners";
import { PARTNER_TERMS_VERSION, partnerCountryOpen, validCountry } from "@/lib/partner-rules";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * POST /api/affiliates: the public partner application. Throttled per IP first. Refused (400 `consent_required`) unless
 * the applicant ticked the required box agreeing to the programme terms (/{lang}/affiliates/terms, rule 414); the
 * application then stores when they agreed and to which version (`PARTNER_TERMS_VERSION`), which the founder console shows.
 * Saudi Arabia only for now (rule 1470): an applicant who lives anywhere else is refused (400 `country_closed`) and nothing
 * is stored.
 */
export async function POST(req: Request) {
  // Public, unauthenticated write: throttled per IP.
  if (!(await allow(`affiliates:ip:${clientIp(req)}`, 10, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = text(b.name, 80), email = text(b.email, 120);
  if (!email || !name) return NextResponse.json({ ok: false }, { status: 400 });
  // Only an explicit yes counts: the checkbox's "on" from a plain form post, or `true` from the page's own script.
  if (b.consent !== true && b.consent !== "on") return NextResponse.json({ ok: false, error: "consent_required" }, { status: 400 });
  if (!partnerCountryOpen(b.country)) return NextResponse.json({ ok: false, error: "country_closed" }, { status: 400 });
  const at = new Date().toISOString();
  // An id, so the founder console can approve or reject this application (src/lib/partners.ts).
  const rec: Application = {
    id: newId("app"), name, email, phone: text(b.phone, 30), channel: text(b.channel, 200), audience: text(b.audience, 100), lang: b.lang === "en" ? "en" : "ar", at,
    consentAt: at, termsVersion: PARTNER_TERMS_VERSION, country: validCountry(b.country)!,
  };
  await pushCapped(APPLICATIONS, JSON.stringify(rec), CAPS.tickets);
  return NextResponse.json({ ok: true });
}
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await db.lrange(APPLICATIONS, 0, 499);
  return NextResponse.json({ ok: true, applications: rows.map((r) => JSON.parse(r)) });
}
