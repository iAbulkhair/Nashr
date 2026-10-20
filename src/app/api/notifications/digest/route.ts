import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { accountKey } from "@/lib/keys";
import { forbid } from "@/lib/roles";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { isEvery, saveDigest } from "@/lib/notif-digest";

/** Saves per login and hour, as the other notification choices (`/api/notifications/prefs`). */
const DIGEST_SAVES_PER_HOUR = 60;

/**
 * PUT /api/notifications/digest `{ every: "off" | "4h" | "day" | "week" }` (rule 2355): how often the account's digest
 * email goes. Owner only (`profile.account`, like every notification choice); members and MCP tokens never write it. The
 * record is the session's own account (`acct(u)`), and the email goes to the owner's own address and language at the
 * time of the save, never to an address from the request.
 */
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "profile.account");
  if (no) return no;
  if (!(await allow(accountKey.digestBucket(u.email), DIGEST_SAVES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => null)) as { every?: unknown } | null;
  if (!b || !isEvery(b.every)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  await saveDigest(acct(u), b.every, u.email, u.lang === "en" ? "en" : "ar");
  return NextResponse.json({ ok: true, every: b.every });
}
