import { NextResponse } from "next/server";
import { baOn } from "@/lib/auth-engine";
import { verifyMagic } from "@/lib/better-auth/handler";
import { globalKey } from "@/lib/keys";
import { allow, clientIp, retryLater } from "@/lib/rate";

/**
 * POST {token}: open a magic link (rule 3416). Only while `AUTH_ENGINE=better-auth`; otherwise 404 before the body or the
 * store is read, as every better-auth route. The page `/{lang}/app/magic` read the token from the URL fragment (rule
 * 546) and posts it only when the person presses its button, so a mail scanner that opens the link uses nothing.
 *
 * The log-in IP bucket of POST /api/auth/login (rule 3414) comes first: a link is a sign-in proof like a password. The
 * verify itself (src/lib/better-auth/handler.ts `verifyMagic`) ends in the session gate, so the answers are the log-in
 * form's: a session and `{ok: true}` (with `verify` for an owner), a refusal with its legacy code, `mfa_required` with
 * the challenge cookie and no session (rule 1934), or `bad_token` for a link that is malformed, expired or used.
 */
export async function POST(req: Request) {
  if (!baOn()) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await allow(globalKey.loginIpBucket(clientIp(req)), 20, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const text = await req.text().catch(() => "");
  let token = "";
  try {
    const b = text.length <= 512 ? (JSON.parse(text || "{}") as { token?: unknown } | null) : null;
    token = typeof b?.token === "string" ? b.token : "";
  } catch {
    token = "";
  }
  return verifyMagic(req, token);
}
