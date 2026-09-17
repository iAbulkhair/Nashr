import { NextResponse } from "next/server";
import { metadata, resourceMetadata } from "@/lib/oauth";
// Served at /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource via rewrites.
export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind");
  const body = kind === "resource" ? resourceMetadata() : metadata();
  return NextResponse.json(body, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
}
export async function OPTIONS() {
  return new NextResponse(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } });
}
