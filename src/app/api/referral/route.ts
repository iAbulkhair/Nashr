import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { referralStats, registerCode } from "@/lib/referral";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  await registerCode(u.email);
  return NextResponse.json({ ok: true, ...(await referralStats(u.email)) });
}
