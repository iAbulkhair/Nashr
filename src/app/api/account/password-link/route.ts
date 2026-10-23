import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { globalKey } from "@/lib/keys";
import { mailReady } from "@/lib/notify";
import { actingLogin } from "@/lib/own-password";
import { mailResetLink } from "@/lib/password-reset";
import { allow, retryLater } from "@/lib/rate";
import { forbid } from "@/lib/roles";

/** Reset links per address and 15 minutes: the forgot route's own bucket, so the two paths share one allowance. */
const LINKS_PER_WINDOW = 3;
const WINDOW_SECONDS = 900;

/**
 * POST {lang}: "Set a password" for a login that has none (rules 3101-3102, a Google sign-up). It mails the same
 * one-hour reset link POST /api/auth/forgot mails (`mailResetLink`, src/lib/password-reset.ts) to the session's OWN
 * login address (`actingLogin`), never to an address from the request: the body carries the language only. Setting the
 * password through that link then follows the reset route (rules 2300-2301): two-step sign-in still asks for its code,
 * and the Google link goes with it, so the person links Google again from Security settings.
 *
 * `password.change` (owner or member, refused while a founder impersonates). A login that already has a password gets
 * 409 `has_password` (it uses the change form). No mail delivery: `{ok: true, mail: false}`, as the forgot route says,
 * so the card points to support. The per-address bucket (`resetLinkBucket`, 3 per 15 minutes) is the forgot route's:
 * 429 `slow_down`. `sent` says whether the provider accepted the message.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "password.change");
  if (no) return no;
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (me.hasPassword) return NextResponse.json({ ok: false, error: "has_password" }, { status: 409 });
  const b = (await req.json().catch(() => ({}))) as { lang?: unknown };
  const lang = b.lang === "en" ? "en" : "ar";
  if (!mailReady()) return NextResponse.json({ ok: true, mail: false, sent: false });
  if (!(await allow(globalKey.resetLinkBucket(me.email), LINKS_PER_WINDOW, WINDOW_SECONDS))) return retryLater({ ok: false, error: "slow_down" }, WINDOW_SECONDS);
  const sent = await mailResetLink(me.email, lang);
  return NextResponse.json({ ok: true, mail: true, sent });
}
