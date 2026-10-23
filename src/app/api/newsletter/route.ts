import { NextResponse } from "next/server";
import { globalKey } from "@/lib/keys";
import { NEWSLETTER_SOURCES, newsletterId, startSubscription, validNewsletterEmail, type NewsletterSource } from "@/lib/newsletter";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { normalizeEmail } from "@/lib/auth";

/** Sign-ups per IP per hour, as the waitlist's. */
const PER_IP = 10;
/** Confirm mails per address per hour: a fourth request inside the hour is answered like the first and sends nothing. */
const PER_EMAIL = 3;

/**
 * POST {email, consent: true, lang?, source?, website?} → asks to join the newsletter (rules 3600-3609, double opt-in).
 * Public, so it is throttled per IP first and per address second. Nothing is subscribed here: a confirm link is mailed
 * and only its click counts (POST ./confirm).
 *
 * The answer never says whether the address was new, pending, subscribed or unsubscribed: every accepted request, and a
 * request the per-address limit swallowed, answers `{ ok: true }`. The only other answers are about the request itself
 * (bad JSON, bad address, no consent), the IP limit, and `mail_off` (503) when no sender is set up so no link could be
 * mailed (nothing is stored then, and the form says so).
 *
 * `website` is a hidden field a person never fills: a request that carries text in it is a script, answered `{ ok: true }`
 * with nothing stored and nothing mailed. No CAPTCHA service. Not logged: the address.
 */
export async function POST(req: Request) {
  if (!(await allow(globalKey.newsletterIpBucket(clientIp(req)), PER_IP, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => null)) as { email?: unknown; consent?: unknown; lang?: unknown; source?: unknown; website?: unknown } | null;
  if (!b || typeof b !== "object") return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  if (typeof b.website === "string" && b.website.trim() !== "") return NextResponse.json({ ok: true });
  const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
  if (!validNewsletterEmail(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  // The box is never pre-ticked: consent is the visitor's own `true`, not a default.
  if (b.consent !== true) return NextResponse.json({ ok: false, error: "consent_required" }, { status: 400 });
  const lang = b.lang === "en" ? "en" : "ar";
  const source: NewsletterSource = (NEWSLETTER_SOURCES as readonly unknown[]).includes(b.source) ? (b.source as NewsletterSource) : "site";
  if (!(await allow(globalKey.newsletterEmailBucket(newsletterId(email)), PER_EMAIL, 3600))) return NextResponse.json({ ok: true });
  try {
    const r = await startSubscription(email, lang, source);
    if (r === "mail_off") return NextResponse.json({ ok: false, error: "mail_off" }, { status: 503 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("newsletter sign-up failed", e instanceof Error ? e.name : "error");
    return NextResponse.json({ ok: false, error: "store_failed" }, { status: 502 });
  }
}
