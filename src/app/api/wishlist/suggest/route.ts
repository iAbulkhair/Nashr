import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { allow } from "@/lib/rate";
import { SUGGESTION_MAX, SUGGESTION_MIN } from "@/lib/changelog";
import { addSuggestion, cleanText } from "@/lib/wishlist";

const SUGGESTIONS_PER_DAY = 5;

/**
 * POST {text, lang?} — a signed-in account suggests a wish. It goes to the founder's moderation queue only: nothing
 * a user types is ever shown on the public page. The founder writes the public title when promoting it.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { text?: unknown; lang?: unknown };
  const text = cleanText(b.text);
  if (text.length < SUGGESTION_MIN) return NextResponse.json({ ok: false, error: "too_short" }, { status: 400 });
  if (text.length > SUGGESTION_MAX) return NextResponse.json({ ok: false, error: "too_long" }, { status: 400 });
  // Counted only for a well-formed suggestion, so a typo does not use up one of the day's five.
  if (!(await allow(`wishsuggest:${u.email}`, SUGGESTIONS_PER_DAY, 86400))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  await addSuggestion(u.email, text, b.lang === "en" ? "en" : "ar");
  return NextResponse.json({ ok: true });
}
