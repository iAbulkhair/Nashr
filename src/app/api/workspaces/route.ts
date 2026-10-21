import { NextResponse } from "next/server";
import { currentPerson } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { isPersonLockTimeout } from "@/lib/person";
import { retryLater, WINDOW } from "@/lib/rate";
import { isTeamLockTimeout } from "@/lib/team";
import { createWorkspace, listWorkspaces } from "@/lib/workspaces";
import { appHref } from "@/lib/ws-path";

/**
 * The person's workspaces (multi-workspace M2, docs/specs/2026-10-18-multi-org.md sections 7, 10 and 16; rule 2123).
 * Behind `currentPerson()`: a valid person with or without a valid workspace (the "no workspace" state), never an
 * impersonation. Outside the second guard (src/lib/ws-path.ts `WORKSPACE_FREE`): these routes choose the workspace.
 * With `MULTI_ORG` off both answer 404.
 *   GET            → {ok, workspaces: [{handle, name, role, current}]}
 *   POST {name, lang?} → {ok, handle, href}; the session now opens the new workspace.
 */
const off = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

export async function GET() {
  if (!MULTI_ORG) return off();
  const me = await currentPerson();
  if (!me) return unauthorized();
  return NextResponse.json({ ok: true, workspaces: await listWorkspaces(me.person, me.acct) });
}

export async function POST(req: Request) {
  if (!MULTI_ORG) return off();
  const me = await currentPerson();
  if (!me) return unauthorized();
  const b = (await req.json().catch(() => ({}))) as { name?: unknown; lang?: unknown };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > 80) return NextResponse.json({ ok: false, error: "invalid_name" }, { status: 400 });
  const lang = b.lang === "en" ? "en" : b.lang === "ar" ? "ar" : me.person.lang;
  let r;
  try {
    r = await createWorkspace(me.person, { name, lang });
  } catch (e) {
    if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
  if (!r.ok) {
    if (r.error === "rate_limited") return retryLater({ ok: false, error: "rate_limited" }, WINDOW.day);
    const status = r.error === "email_unverified" ? 403 : r.error === "not_found" ? 401 : 409;
    return NextResponse.json({ ok: false, error: r.error }, { status });
  }
  return NextResponse.json({ ok: true, handle: r.handle, href: appHref(lang, "", r.handle) });
}
