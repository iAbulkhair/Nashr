import { NextResponse } from "next/server";
import { resourceMetadata } from "@/lib/oauth";
export async function GET() {
  return NextResponse.json(resourceMetadata(), { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
}
export async function OPTIONS() {
  return new NextResponse(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } });
}
