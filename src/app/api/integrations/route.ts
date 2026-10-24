import { NextResponse } from "next/server";
import { forbid } from "@/lib/roles";
import { currentUser, isAdmin } from "@/lib/auth";
import { CAPS, db, pushCapped } from "@/lib/db";
import { INTEGRATIONS } from "@/lib/integrations";
import { allow, INTEGRATION_REQUESTS_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";

export async function GET(req: Request) {
  if (await isAdmin(req)) {
    const rows = await db.lrange("integration-requests", 0, 499);
    return NextResponse.json({ ok: true, requests: rows.map((r) => JSON.parse(r)) });
  }
  return NextResponse.json({ ok: true, integrations: INTEGRATIONS });
}

const LISTED = new Map(INTEGRATIONS.map((i) => [i.id, i.name]));

/**
 * POST {id, name?} → record a request / vote.
 *
 * A vote counts only for an id in the catalogue (`INTEGRATIONS`), keyed by that id, and the log row names the catalogue's
 * own name: a request body can no longer mint a new `integration-votes:*` key per call. A free-text request from the
 * "other" box (`id` = "other:…") is logged with its text cut to 80 characters and counted under the one `other` key.
 * Rate limited per login (rule 1353, 360 study C-016).
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // A Viewer reads and comments only: no agent runs, no credits spent (rule 3752).
  const no = forbid(u, "integrations.request");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
  const id = typeof b.id === "string" ? b.id : "";
  const listed = LISTED.get(id);
  const other = !listed && id.startsWith("other:") ? (typeof b.name === "string" && b.name.trim() ? b.name : id.slice(6)).trim().slice(0, 80) : "";
  if (!listed && !other) return NextResponse.json({ ok: false, error: "missing" }, { status: 400 });
  // The person asking (a member's own login for a member), and the account they asked from.
  const who = u.actor?.email ?? u.email;
  if (!(await allow(`intreq:${who}`, INTEGRATION_REQUESTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const [, n] = await Promise.all([
    pushCapped("integration-requests", JSON.stringify({ email: who, account: u.email, name: listed ?? other, ...(listed ? { id } : { other: true }), at: new Date().toISOString() }), CAPS.tickets),
    db.incrby(`integration-votes:${listed ? id : "other"}`, 1),
  ]);
  return NextResponse.json({ ok: true, votes: n });
}
