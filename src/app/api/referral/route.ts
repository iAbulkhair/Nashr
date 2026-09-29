import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { referralStats, registerCode } from "@/lib/referral";
import { forbid } from "@/lib/roles";

/** Owner only (src/lib/roles.ts "referral"): the stats name the people the owner referred, by email. */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "referral");
  if (no) return no;
  await registerCode(u.email);
  return NextResponse.json({ ok: true, ...(await referralStats(u.email)) });
}
