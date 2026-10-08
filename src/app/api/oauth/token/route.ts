import { NextResponse } from "next/server";
import { getClient, issueTokens, redeemCode, rotateRefresh } from "@/lib/oauth";
import { allow, clientIp, OAUTH_TOKEN_PER_IP, OAUTH_TOKEN_WINDOW, retryLater, sameSecret } from "@/lib/rate";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "*", "Cache-Control": "no-store" };
const err = (e: string, d?: string) => NextResponse.json({ error: e, error_description: d }, { status: 400, headers: cors });

export async function POST(req: Request) {
  // Before the body is read or any client is looked up.
  if (!(await allow(`oauth:token:ip:${clientIp(req)}`, OAUTH_TOKEN_PER_IP, OAUTH_TOKEN_WINDOW)))
    return retryLater({ error: "slow_down", error_description: "too many requests" }, OAUTH_TOKEN_WINDOW, cors);
  const ct = req.headers.get("content-type") ?? "";
  let b: Record<string, string> = {};
  if (ct.includes("application/json")) b = await req.json().catch(() => ({}));
  else b = Object.fromEntries(new URLSearchParams(await req.text()));
  // client auth: Basic header or client_secret_post or public (none)
  const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/);
  if (basic) { const [id, sec] = Buffer.from(basic[1], "base64").toString().split(":"); b.client_id ??= id; b.client_secret ??= sec; }
  const client = b.client_id ? await getClient(b.client_id) : null;
  if (!client) return err("invalid_client");
  // Constant time. A JSON body can carry a non-string secret, which Buffer.from would throw on: it is simply wrong.
  if (client.client_secret && !sameSecret(client.client_secret, typeof b.client_secret === "string" ? b.client_secret : "")) return err("invalid_client", "bad secret");

  if (b.grant_type === "authorization_code") {
    if (!b.code || !b.code_verifier || !b.redirect_uri) return err("invalid_request", "code, code_verifier, redirect_uri required");
    const p = await redeemCode(b.code, client.client_id, b.redirect_uri, b.code_verifier);
    if (!p) return err("invalid_grant");
    return NextResponse.json(await issueTokens(p.email, client.client_id, p.scope), { headers: cors });
  }
  if (b.grant_type === "refresh_token") {
    const t = b.refresh_token ? await rotateRefresh(b.refresh_token, client.client_id) : null;
    return t ? NextResponse.json(t, { headers: cors }) : err("invalid_grant");
  }
  return err("unsupported_grant_type");
}
export async function OPTIONS() { return new NextResponse(null, { headers: cors }); }
