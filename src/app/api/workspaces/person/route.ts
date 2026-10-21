import { NextResponse } from "next/server";
import { currentPerson, destroySession } from "@/lib/auth";
import { freshProof } from "@/lib/fresh-proof";
import { personKey } from "@/lib/keys";
import { MULTI_ORG } from "@/lib/multi-org";
import { deletePerson } from "@/lib/person-delete";
import { isPersonLockTimeout } from "@/lib/person";
import { allow, retryLater } from "@/lib/rate";
import { isTeamLockTimeout } from "@/lib/team";
import { splitPerson } from "@/lib/transfer";

export const dynamic = "force-dynamic";

/** Delete attempts per person per hour: each one checks a password, so it is metered on top of the password bucket. */
const DELETES_PER_HOUR = 5;

const fail = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });
const lockTimeout = (e: unknown) => isTeamLockTimeout(e) || isPersonLockTimeout(e);

/**
 * DELETE /api/workspaces/person {password, code?} → {ok} (multi-workspace M3, rules 2127, 2754): the signed-in person
 * deletes their own login. Behind `currentPerson()` (an impersonation has no person: 401). A fresh proof first: the
 * person's own password and, while two-step sign-in is on, a code (a recovery code is accepted here, as for turning
 * two-step off). Refused 409 `owns_workspace` while the person owns an account and `delete_unavailable` for a
 * legacy-shaped person (M4/S2). Otherwise every membership, the login, sessions, devices, passkeys and two-step state go
 * (`deletePerson`) and this device is signed out. With `MULTI_ORG` off, 404.
 */
export async function DELETE(req: Request) {
  if (!MULTI_ORG) return fail("not_found", 404);
  const me = await currentPerson();
  if (!me) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!(await allow(personKey.deleteBucket(me.person.pid), DELETES_PER_HOUR, 3600))) return retryLater({ ok: false, error: "rate_limited" }, 3600);
  if (!splitPerson(me.person)) return fail("delete_unavailable", 409);
  const b = (await req.json().catch(() => ({}))) as { password?: unknown; code?: unknown };
  const proof = await freshProof(req, me.person, me.person.createdAt || undefined, b, { recovery: true });
  if (proof) return proof;
  try {
    const r = await deletePerson(me.person);
    if (!r.ok) return fail(r.error, 409);
  } catch (e) {
    if (lockTimeout(e)) return fail("busy", 409);
    throw e;
  }
  await destroySession();
  return NextResponse.json({ ok: true });
}
