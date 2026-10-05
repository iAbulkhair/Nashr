import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow } from "@/lib/rate";
import { SEC_READS_PER_HOUR, SEC_WRITES_PER_HOUR } from "@/lib/secretary";
import { dropPending, getPending, liveBooking } from "@/lib/secretary-meeting";

/**
 * The follow-up after a meeting (Reem phase 3 B2b, src/lib/secretary-meeting.ts): the tasks proposed for one booking item
 * and waiting for the owner. Authenticates first; the id is the item's, format-checked, and must be a live (not deleted)
 * `booking` item of the caller's active brand (`sc(u)`), else 404 whatever other brands hold; nothing is read or deleted
 * for an id that is not. GET (`read`; `sec:read:{email}`): `{ ok: true, proposals }`, an empty list when nothing is pending.
 * DELETE (`todo.write`; `sec:write:{email}`, like the other Reem writes): discards the pending set, idempotently (200 whether
 * or not there was one). Neither creates an item: that is `POST .../approve` alone.
 */
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
const tooMany = () => NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "read");
  if (no) return no;
  if (!(await allow(`sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600))) return tooMany();
  const { id } = await ctx.params;
  const scope = sc(u);
  if (!(await liveBooking(scope, id))) return notFound();
  return NextResponse.json({ ok: true, proposals: (await getPending(scope, id)) ?? [] }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return tooMany();
  const { id } = await ctx.params;
  const scope = sc(u);
  if (!(await liveBooking(scope, id))) return notFound();
  await dropPending(scope, id);
  return NextResponse.json({ ok: true });
}
