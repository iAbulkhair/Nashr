import { NextResponse } from "next/server";
import { googleSignInOn, startGoogle } from "@/lib/google-signin";
import { allow, clientIp, retryLater } from "@/lib/rate";

/** Starts per client address and 15 minutes: each one stores a short record and sets a cookie. */
const STARTS_PER_IP = 30;

/**
 * GET /api/auth/google/start?mode=login|signup&lang&next&ref (rules 1946-1953, docs/specs/2026-10-13-google-sign-in.md).
 * Public (rate limited per address). 404 while Google sign-in is off. Linking a Google account to a signed-in login is
 * not started here any more: it needs the login's password (rule 2302), which never rides in a URL, so it is
 * POST /api/account/google {action: "link", password}. `mode=link` here is refused.
 */
export async function GET(req: Request) {
  if (!googleSignInOn()) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await allow(`gsi:ip:${clientIp(req)}`, STARTS_PER_IP, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const q = new URL(req.url).searchParams;
  const m = q.get("mode");
  if (m === "link") return NextResponse.json({ ok: false, error: "use_post" }, { status: 405 });
  const mode = m === "signup" ? "signup" : "login";
  const to = await startGoogle({ mode, next: q.get("next") ?? "", lang: q.get("lang"), ref: q.get("ref") ?? "" });
  if (!to) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.redirect(to, 303);
}
