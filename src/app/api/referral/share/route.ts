import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { adjust } from "@/lib/credits";
import { db } from "@/lib/db";
import { SHARE_CREDITS } from "@/lib/referral";
import { forbid } from "@/lib/roles";
import { accountKey } from "@/lib/keys";
import { acct } from "@/lib/account-id";

const PLATFORMS = ["x", "linkedin", "whatsapp", "instagram"];
/** Accounts that claimed before the marker moved into a set still have their per-platform key. */
const legacyKey = (email: string, platform: string) => accountKey.shared(email, platform);

/**
 * POST {platform} → one-time credits for sharing Nashr on a social platform (once per platform per account).
 * Owner only, like the rest of the refer page (src/lib/roles.ts "referral"): the bonus lands on the account's balance.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "referral");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { platform?: string };
  if (!b.platform || !PLATFORMS.includes(b.platform)) return NextResponse.json({ ok: false, error: "bad_platform" }, { status: 400 });
  // Read-then-write was a race: ten concurrent POSTs each saw no marker and each took the bonus, minting ten times the
  // credits. `sadd` answers 1 only for the caller that actually added the member, so exactly one of them is paid.
  if (await db.get(legacyKey(u.email, b.platform))) return NextResponse.json({ ok: true, credited: 0, credits: u.credits, already: true });
  const isNew = await db.sadd(accountKey.shared(acct(u)), b.platform);
  if (!isNew) return NextResponse.json({ ok: true, credited: 0, credits: u.credits, already: true });
  const credits = await adjust(u.email, SHARE_CREDITS);
  return NextResponse.json({ ok: true, credited: SHARE_CREDITS, credits });
}
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "referral");
  if (no) return no;
  const [claimed, legacy] = await Promise.all([
    db.smembers(accountKey.shared(acct(u))),
    Promise.all(PLATFORMS.map(async (p) => ((await db.get(legacyKey(u.email, p))) ? p : ""))),
  ]);
  const done = [...new Set([...claimed, ...legacy.filter(Boolean)])].filter((p) => PLATFORMS.includes(p));
  return NextResponse.json({ ok: true, done, credits: SHARE_CREDITS });
}
