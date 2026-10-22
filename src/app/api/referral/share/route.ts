import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { adjust } from "@/lib/credits";
import { db } from "@/lib/db";
import { SHARE_CREDITS } from "@/lib/referral";
import { forbid } from "@/lib/roles";
import { accountKey } from "@/lib/keys";
import { acct } from "@/lib/account-id";

const PLATFORMS = ["x", "linkedin", "whatsapp", "instagram"];
/** Accounts that claimed before the marker moved into a set still have their per-platform key, written under the account key (then its address). */
const legacyKey = (email: string, platform: string) => accountKey.shared(email, platform);
/**
 * The old marker is looked for under the account key and, when it differs, the login address it was first written under
 * (an account whose keys the R1 script has not moved yet), so a platform claimed before either change is never paid twice.
 */
const legacyClaimed = async (u: { id?: string; email: string }, platform: string) => {
  const ids = [...new Set([acct(u), u.email])];
  return (await Promise.all(ids.map((id) => db.get(legacyKey(id, platform))))).some(Boolean);
};

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
  if (await legacyClaimed(u, b.platform)) return NextResponse.json({ ok: true, credited: 0, credits: u.credits, already: true });
  const isNew = await db.sadd(accountKey.shared(acct(u)), b.platform);
  if (!isNew) return NextResponse.json({ ok: true, credited: 0, credits: u.credits, already: true });
  const credits = await adjust(acct(u), SHARE_CREDITS);
  return NextResponse.json({ ok: true, credited: SHARE_CREDITS, credits });
}
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "referral");
  if (no) return no;
  const [claimed, legacy] = await Promise.all([
    db.smembers(accountKey.shared(acct(u))),
    Promise.all(PLATFORMS.map(async (p) => ((await legacyClaimed(u, p)) ? p : ""))),
  ]);
  const done = [...new Set([...claimed, ...legacy.filter(Boolean)])].filter((p) => PLATFORMS.includes(p));
  return NextResponse.json({ ok: true, done, credits: SHARE_CREDITS });
}
