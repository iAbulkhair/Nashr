import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { removeAvatar, setAvatar } from "@/lib/avatar";
import { personKey } from "@/lib/keys";
import { actingLogin } from "@/lib/own-password";
import { WINDOW, allow, retryLater } from "@/lib/rate";
import { AVATAR_UPLOAD, readCappedBody, takeUpload } from "@/lib/upload";

/** Avatar changes per person and hour (rule 3502): each one re-encodes an image. */
const AVATAR_CHANGES_PER_HOUR = 20;
export const runtime = "nodejs";

const STATUS: Record<string, number> = { bad_type: 415, too_large: 413, bad_input: 400, not_found: 404, convert_failed: 422, no_store: 503, full: 507, put_failed: 503, busy: 409 };
const fail = (error: string) => NextResponse.json({ ok: false, error }, { status: STATUS[error] ?? 400 });

/**
 * POST /api/account/avatar (rule 3502): set the signed-in person's picture. Two bodies:
 *  - an image (`Content-Type: image/jpeg|png|webp`), read with a running cap of 5 MB: the server upload, today's only path
 *    (the disk cannot sign);
 *  - JSON `{name}`: the completion of a signed upload `POST /api/account/avatar/upload` planned. The name is found only
 *    under this person's own ticket (`upload:p:{pid}:{name}`), so another person's name finds nothing.
 * The person is the session's (`actingLogin`): a founder impersonating and an MCP token are refused, so nobody changes a
 * person's face but that person. Rate limited per person.
 * DELETE removes the picture.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!(await allow(personKey.avatarSetBucket(me.pid), AVATAR_CHANGES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let raw: Buffer;
  if (type === "application/json") {
    const b = (await req.json().catch(() => ({}))) as { name?: unknown };
    const got = await takeUpload(personKey.uploadOwner(me.pid), AVATAR_UPLOAD, b.name);
    if (!got.ok) return fail(got.error);
    raw = got.body;
  } else {
    if (!AVATAR_UPLOAD.contentTypes.includes(type)) return fail("bad_type");
    const body = await readCappedBody(req, AVATAR_UPLOAD.maxBytes);
    if (body === "too_large") return fail("too_large");
    if (!body) return fail("bad_input");
    raw = body;
  }
  const r = await setAvatar(me.pid, raw);
  return r.ok ? NextResponse.json({ ok: true, url: r.url }) : fail(r.error);
}

export async function DELETE() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  await removeAvatar(me.pid);
  return NextResponse.json({ ok: true });
}
