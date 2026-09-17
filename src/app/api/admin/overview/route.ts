import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { overview } from "@/lib/admin-stats";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, ...(await overview()) });
}
