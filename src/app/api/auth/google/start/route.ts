import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { googleSignInOn, startGoogle, type GoogleMode } from "@/lib/google-signin";
import { actingLogin } from "@/lib/own-password";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { forbid } from "@/lib/roles";

/** Starts per client address and 15 minutes: each one stores a short record and sets a cookie. */
const STARTS_PER_IP = 30;

/**
 * GET /api/auth/google/start?mode=login|signup|link&lang&next&ref (rules 1946-1953, docs/specs/2026-10-13-google-sign-in.md).
 * Public for "login" and "signup" (rate limited per address); "link" needs a session and `google.manage`, and records
 * the acting login so the callback links nothing to anyone else. 404 while Google sign-in is off.
 */
export async function GET(req: Request) {
  if (!googleSignInOn()) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await allow(`gsi:ip:${clientIp(req)}`, STARTS_PER_IP, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const q = new URL(req.url).searchParams;
  const m = q.get("mode");
  const mode: GoogleMode = m === "signup" || m === "link" ? m : "login";
  let login: string | undefined;
  if (mode === "link") {
    const u = await currentUser();
    if (!u) return NextResponse.json({ ok: false }, { status: 401 });
    const no = forbid(u, "google.manage");
    if (no) return no;
    login = (await actingLogin(u))?.email;
    if (!login) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const to = await startGoogle({ mode, next: q.get("next") ?? "", lang: q.get("lang"), ref: q.get("ref") ?? "", login });
  if (!to) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.redirect(to, 303);
}
