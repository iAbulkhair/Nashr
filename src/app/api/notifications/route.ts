import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { NOTIF_ID, listNotifs, markAllRead, markRead } from "@/lib/notifications";
import { acct } from "@/lib/account-id";

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const all = await listNotifs(acct(u));
  const unread = all.filter((n) => !n.read).length;
  if (new URL(req.url).searchParams.get("count")) return NextResponse.json({ ok: true, unread });
  return NextResponse.json({ ok: true, notifications: all, unread });
}

/**
 * POST /api/notifications marks the session's own bell read. With no body (the old call, "Mark all as read") every entry;
 * with `{ id }` that one entry only (rule 1966) → `{ ok, unread }`. The id is looked up inside the account's list and
 * never becomes part of a key; one of the wrong shape is 400, one the list does not hold is 404.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (b && typeof b === "object" && "id" in b) {
    if (typeof b.id !== "string" || !NOTIF_ID.test(b.id)) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
    const unread = await markRead(u.email, b.id);
    if (unread === null) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, unread });
  }
  await markAllRead(u.email);
  return NextResponse.json({ ok: true, unread: 0 });
}
