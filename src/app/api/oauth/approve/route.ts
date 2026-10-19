import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { SCOPES, getClient, issueCode, validRedirectUri } from "@/lib/oauth";
import { forbid } from "@/lib/roles";

/** The address back to the client: a 303 for a plain form post, or JSON for the consent page's own request. */
const sendBack = (req: Request, to: URL) =>
  (req.headers.get("accept") ?? "").includes("application/json") ? NextResponse.json({ ok: true, redirect: to.toString() }) : NextResponse.redirect(to.toString(), 303);

/**
 * Consent form POST → authorization code → redirect back to the client.
 *
 * Rule 2305: the consent page asks with `Accept: application/json` and gets `{ok, redirect}` instead of the 303, then
 * navigates there itself. Chrome applies the enforced CSP's `form-action 'self'` to a form POST's redirect and blocked the
 * 303 to the client's (other-origin) redirect_uri. Same address either way; only who follows it changes.
 *
 * Owner only, and never while a founder impersonates (src/lib/roles.ts "oauth.approve"): the code becomes tokens that
 * act as the whole account and outlive any session, so a member or a two-hour impersonation must not mint them.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "oauth.approve");
  if (no) return no;
  const f = Object.fromEntries(new URLSearchParams(await req.text()));
  const client = await getClient(f.client_id ?? "");
  // Checked against the stored list AND against the rule itself. Registration is where the https requirement is
  // applied, but a client registered before that requirement existed still carries whatever it asked for, and this
  // is the moment an authorization code is about to be sent somewhere. Validate at the point of trust.
  if (!client || !client.redirect_uris.includes(f.redirect_uri) || !validRedirectUri(f.redirect_uri)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const u2 = new URL(f.redirect_uri);
  if (f.decision !== "allow") {
    u2.searchParams.set("error", "access_denied");
    if (f.state) u2.searchParams.set("state", f.state);
    return sendBack(req, u2);
  }
  if (!f.code_challenge || f.code_challenge_method !== "S256") return NextResponse.json({ error: "invalid_request", error_description: "PKCE S256 required" }, { status: 400 });
  const code = await issueCode({ client_id: client.client_id, redirect_uri: f.redirect_uri, challenge: f.code_challenge, email: acct(u), scope: SCOPES.includes(f.scope) ? f.scope : SCOPES[0] }); // only scopes this server defines are ever written into a token
  u2.searchParams.set("code", code);
  if (f.state) u2.searchParams.set("state", f.state);
  return sendBack(req, u2);
}
