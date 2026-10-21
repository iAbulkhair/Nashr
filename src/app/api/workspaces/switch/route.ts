import { NextResponse } from "next/server";
import { currentPerson } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { switchWorkspace } from "@/lib/workspaces";
import { appHref } from "@/lib/ws-path";

/**
 * POST /api/workspaces/switch {handle} (multi-workspace M2, spec section 7 "Switching"; rule 2112): the session opens the
 * workspace `handle` names when it is one the person holds now; its `acct` and `lastorg:` move, its brand choice does
 * not. A foreign, stale, made-up or malformed handle answers the same 404 `not_found` with nothing written. Behind
 * `currentPerson()`, so an impersonation (no person) answers 401. With `MULTI_ORG` off, 404.
 *   → {ok, handle, href}: the switcher navigates there (at the same sub-path when it can).
 */
export async function POST(req: Request) {
  if (!MULTI_ORG) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const me = await currentPerson();
  if (!me) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { handle?: unknown };
  const aid = await switchWorkspace(me.person, b.handle);
  if (!aid) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const handle = b.handle as string;
  return NextResponse.json({ ok: true, handle, href: appHref(me.person.lang, "", handle) });
}
