import { NextResponse } from "next/server";
import { registerClient } from "@/lib/oauth";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "*" };
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const c = await registerClient(b);
    return NextResponse.json({ ...c, client_id_issued_at: c.created_at, token_endpoint_auth_method: c.client_secret ? "client_secret_post" : "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, { status: 201, headers: cors });
  } catch (e) {
    return NextResponse.json({ error: "invalid_client_metadata", error_description: e instanceof Error ? e.message : "bad request" }, { status: 400, headers: cors });
  }
}
export async function OPTIONS() { return new NextResponse(null, { headers: cors }); }
