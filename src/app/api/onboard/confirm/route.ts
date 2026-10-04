import { NextResponse } from "next/server";
import { currentUser, sc, trialOver } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { confirmAnswers, confirmOnboard, heldOnboard, onboardUrl } from "@/lib/onboard-confirm";
import { parseAnswers } from "@/lib/dictionary";
import { onboardCost } from "@/lib/pricing";
import { forbid } from "@/lib/roles";

/**
 * The owner's "build my workspace from this site", pressed on the start page. POST {url, answers?} → {ok, cost, paid?}.
 * `answers` is the first-login game's (src/lib/dictionary.ts `GameAnswers`), stored beside the URL for the build to use.
 * Nothing is crawled, no model is called and nothing is charged here: it only records the one URL `POST /api/onboard`
 * may build from (src/lib/onboard-confirm.ts). The session cookie is SameSite=Lax, so another site cannot submit this
 * for a signed-in owner.
 *
 * `cost` is what the build will charge (src/lib/pricing.ts `onboardCost`): 0 for the first brand, ONBOARD_EXTRA_BRAND_COST
 * for an added one, which the start page shows before Go. An added brand the account cannot pay for is refused here
 * with 402 {error: "no_credits" | "trial_over", need, credits}, so the owner sees the paywall on the start page instead
 * of a failed build in chat; a build already paid for (a charge held on the account, `User.onboardPaid`) is not asked
 * again and answers `paid: true`. The charge itself, and its authoritative checks, are in POST /api/onboard. Rule 246.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "onboard");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { url?: unknown; answers?: unknown };
  const url = onboardUrl(b.url);
  if (url.length < 4) return NextResponse.json({ ok: false, error: "bad_url" }, { status: 400 });
  // The first-login game's answers are optional (a confirm from before the game still builds), but when sent they must
  // be a finished game: anything else is refused before a key is written. Rule 522.
  const sent = b.answers !== undefined && b.answers !== null;
  const answers = sent ? parseAnswers(b.answers) : null;
  if (sent && !answers) return NextResponse.json({ ok: false, error: "bad_answers" }, { status: 400 });
  const scope = sc(u);
  const cost = onboardCost(u.brandId);
  const marker = cost > 0 ? heldOnboard(u, scope) : null;
  const brand = await getBrand(scope);
  if (brand) return NextResponse.json({ ok: false, error: "already_onboarded" }, { status: 409 });
  if (cost > 0 && !marker) {
    const credits = Number.isFinite(u.credits) ? u.credits : 0;
    if (trialOver(u)) return NextResponse.json({ ok: false, error: "trial_over", need: cost, credits }, { status: 402 });
    if (credits < cost) return NextResponse.json({ ok: false, error: "no_credits", need: cost, credits }, { status: 402 });
  }
  await Promise.all([confirmOnboard(scope, url), confirmAnswers(scope, answers)]);
  return NextResponse.json({ ok: true, cost, ...(marker ? { paid: true } : {}) });
}
