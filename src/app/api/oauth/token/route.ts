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
  let raw: unknown = {};
  if (ct.includes("application/json")) raw = await req.json().catch(() => ({}));
  else raw = Object.fromEntries(new URLSearchParams(await req.text()));
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // client auth: Basic header or client_secret_post or public (none)
  const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/);
  const [bid, bsec] = basic ? Buffer.from(basic[1], "base64").toString().split(":") : [];
  // Every field is a string from here on (rule 2932): a JSON body can carry a number, an object or an array, which the
  // hashing of a code or token (`tokenHash`) throws on. A non-string is simply wrong, so it is answered as missing.
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const b = {
    grant_type: s(o.grant_type),
    client_id: s(o.client_id ?? bid),
    client_secret: s(o.client_secret ?? bsec),
    code: s(o.code),
    code_verifier: s(o.code_verifier),
    redirect_uri: s(o.redirect_uri),
    refresh_token: s(o.refresh_token),
  };
  const client = b.client_id ? await getClient(b.client_id) : null;
  if (!client) return err("invalid_client");
  // Constant time. A JSON body can carry a non-string secret, which Buffer.from would throw on: it is simply wrong.
  if (client.client_secret && !sameSecret(client.client_secret, b.client_secret)) return err("invalid_client", "bad secret");

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
