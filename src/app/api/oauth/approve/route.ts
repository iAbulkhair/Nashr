import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { SCOPES, getClient, issueCode } from "@/lib/oauth";

/** Consent form POST → authorization code → redirect back to the client. */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const f = Object.fromEntries(new URLSearchParams(await req.text()));
  const client = await getClient(f.client_id ?? "");
  if (!client || !client.redirect_uris.includes(f.redirect_uri)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const u2 = new URL(f.redirect_uri);
  if (f.decision !== "allow") {
    u2.searchParams.set("error", "access_denied");
    if (f.state) u2.searchParams.set("state", f.state);
    return NextResponse.redirect(u2.toString(), 303);
  }
  if (!f.code_challenge || f.code_challenge_method !== "S256") return NextResponse.json({ error: "invalid_request", error_description: "PKCE S256 required" }, { status: 400 });
  const code = await issueCode({ client_id: client.client_id, redirect_uri: f.redirect_uri, challenge: f.code_challenge, email: u.email, scope: SCOPES.includes(f.scope) ? f.scope : SCOPES[0] }); // only scopes this server defines are ever written into a token
  u2.searchParams.set("code", code);
  if (f.state) u2.searchParams.set("state", f.state);
  return NextResponse.redirect(u2.toString(), 303);
}
