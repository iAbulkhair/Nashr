import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { accountKey } from "@/lib/keys";
import { aidOf } from "@/lib/membership";
import { WINDOW, allow, retryLater } from "@/lib/rate";
import { can } from "@/lib/roles";
import { LOGO_UPLOAD, readCappedBody, takeUpload } from "@/lib/upload";
import { removeLogo, setLogo } from "@/lib/workspace-logo";

/** Logo changes per workspace and hour (rule 3611): each one re-encodes an image. */
const LOGO_CHANGES_PER_HOUR = 20;
export const runtime = "nodejs";

const STATUS: Record<string, number> = { bad_type: 415, too_large: 413, bad_input: 400, not_found: 404, convert_failed: 422, no_store: 503, full: 507, put_failed: 503, busy: 409 };
const fail = (error: string) => NextResponse.json({ ok: false, error }, { status: STATUS[error] ?? 400 });

/**
 * POST /api/account/logo (rules 3610-3611): set the signed-in workspace's logo. An owner or an admin only
 * (`workspace.logo`): a member, an AI client's token and a founder impersonating are refused. The workspace is the
 * session's account (`aidOf(u)`), never one from the request. Two bodies:
 *  - an image (`Content-Type: image/jpeg|png|webp`), read with a running cap of 5 MB: the server upload;
 *  - JSON `{name}`: the completion of a signed upload `POST /api/account/logo/upload` planned. The name is found only under
 *    this workspace's own logo ticket (`upload:w:{aid}:{name}`, kind "logo"), so a picture's ticket or another workspace's
 *    name finds nothing.
 * Rate limited per workspace. DELETE removes the logo.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!can(u, "workspace.logo")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const aid = aidOf(u);
  if (!(await allow(accountKey.logoSetBucket(aid), LOGO_CHANGES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let raw: Buffer;
  if (type === "application/json") {
    const b = (await req.json().catch(() => ({}))) as { name?: unknown };
    const got = await takeUpload(accountKey.logoUploadOwner(aid), LOGO_UPLOAD, b.name);
    if (!got.ok) return fail(got.error);
    raw = got.body;
  } else {
    if (!LOGO_UPLOAD.contentTypes.includes(type)) return fail("bad_type");
    const body = await readCappedBody(req, LOGO_UPLOAD.maxBytes);
    if (body === "too_large") return fail("too_large");
    if (!body) return fail("bad_input");
    raw = body;
  }
  const r = await setLogo(aid, raw);
  return r.ok ? NextResponse.json({ ok: true, url: r.url }) : fail(r.error);
}

export async function DELETE() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!can(u, "workspace.logo")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const aid = aidOf(u);
  if (!(await allow(accountKey.logoSetBucket(aid), LOGO_CHANGES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  await removeLogo(aid);
  return NextResponse.json({ ok: true });
}
