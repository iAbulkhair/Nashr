import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { SUGGESTION_MAX, SUGGESTION_MIN } from "@/lib/changelog";
import { addSuggestion, cleanText } from "@/lib/wishlist";

const SUGGESTIONS_PER_DAY = 5;

/** The text as `cleanText` leaves it, between the two lengths; any `lang` other than "en" is Arabic. */
const suggestion = z.looseObject({
  // `.optional()` first: a key the body leaves out reaches the transform as undefined instead of failing (zod 4).
  text: z.unknown().optional().transform(cleanText).pipe(z.string().min(SUGGESTION_MIN, { error: "too_short" }).max(SUGGESTION_MAX, { error: "too_long" })),
  lang: z.unknown().optional().transform((v) => (v === "en" ? "en" : "ar")),
});

/**
 * POST {text, lang?} — a signed-in account suggests a wish. It goes to the founder's moderation queue only: nothing
 * a user types is ever shown on the public page. The founder writes the public title when promoting it.
 * The rate limit is taken inside, after the text is checked, not by the wrapper (which counts before the body).
 */
export const POST = handler({ auth: "user", unauthorized: "auth", input: suggestion }, async ({ u, input: b }) => {
  // Counted only for a well-formed suggestion, so a typo does not use up one of the day's five.
  if (!(await allow(`wishsuggest:${u.email}`, SUGGESTIONS_PER_DAY, WINDOW.day))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.day);
  await addSuggestion(u.email, b.text, b.lang);
  return NextResponse.json({ ok: true });
});
