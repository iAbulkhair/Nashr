import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { forbid } from "@/lib/roles";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { parsePrefs, profileKey, storedFrom } from "@/lib/notify-prefs";

/** Saves per account and hour: a person toggling switches saves a few times; a script cannot rewrite the record in a loop. */
const NOTIFY_PREFS_PER_HOUR = 60;

/**
 * PUT /api/notifications/prefs (rule 1145): the notification preferences of the caller's active brand, per type and
 * channel. Owner only (`profile.account`, the same action as the old email preference on PUT /api/profile); members and
 * MCP tokens read the page, never write it. The key is the session's own scope (`sc(u)`), never one from the request.
 * The body is the whole set of choices; a missing or mistyped part refuses the save before anything is written. The
 * record gets the new shape and the old `emails` field derived from it (expand step, src/lib/notify-prefs.ts).
 */
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "profile.account");
  if (no) return no;
  if (!(await allow(`notifyprefs:${u.email}`, NOTIFY_PREFS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const prefs = parsePrefs(await req.json().catch(() => null));
  if (!prefs) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  await db.set(profileKey(sc(u)), storedFrom(prefs));
  return NextResponse.json({ ok: true, prefs });
}
