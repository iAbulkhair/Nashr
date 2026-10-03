import { NextResponse } from "next/server";
import { currentUser, sc, type User } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow } from "@/lib/rate";
import { SEC_READS_PER_HOUR, SEC_WRITES_PER_HOUR, zoneFor, type SecFail, type Who } from "@/lib/secretary";
import { endAway, listAway, setAway } from "@/lib/secretary-away";

/**
 * Contacts who are away, for the signed-in account's active brand (`sc(u)`): `sec:away:{scope}` (src/lib/secretary-away.ts).
 * GET: the list, ended entries marked `ended` (`read`, any member, rate `sec:read`).
 * PUT `{ label, until, note? }`: mark a contact away until `until` (inclusive, the brand's local day), or replace their
 * entry (`todo.write`, any member, rate `sec:write`). DELETE `{ label, remove? }`: end the absence now, idempotently (an
 * entry that has already ended stays as it is, ruling R21); `remove: true` deletes the entry instead, ended or not
 * (`todo.write`, rate `sec:write`). Each authenticates, then checks the role, then the rate limit, then reads the body,
 * of which only `label`, `until`, `note` and `remove` are read: a `scope`, `email`, `by` or `via` there changes nothing.
 * The owner, an alias of the owner or an agent is refused (`not_contact`); 200 entries per brand, ended ones included
 * (`away_limit`).
 */
const refused = (r: SecFail) => NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
const badRequest = () => NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
/** A person in the app ("owner" in Reem's words), and which login acted. */
const personOf = (u: User): Who => ({ actor: "owner", via: "web", login: u.actor?.email });

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  const b: unknown = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  if (!(await allow(`sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const scope = sc(u);
  const now = Date.now();
  return NextResponse.json({ ok: true, entries: await listAway(scope, now, await zoneFor(scope)) });
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const b = await bodyOf(req);
  if (!b) return badRequest();
  const scope = sc(u);
  const now = Date.now();
  const r = await setAway(scope, { label: b.label, until: b.until, note: b.note }, personOf(u), now, await zoneFor(scope));
  if (!r.ok) return refused(r);
  return NextResponse.json({ ok: true, entry: r.entry });
}

export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const b = await bodyOf(req);
  if (!b || (b.remove !== undefined && typeof b.remove !== "boolean")) return badRequest();
  const scope = sc(u);
  const now = Date.now();
  const r = await endAway(scope, b.label, personOf(u), now, await zoneFor(scope), { remove: b.remove === true });
  if (!r.ok) return refused(r);
  return NextResponse.json({ ok: true, entry: r.entry, removed: r.removed, changed: r.changed });
}
