import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { accountKey } from "@/lib/keys";
import { aidOf } from "@/lib/membership";
import { WINDOW, allow, retryLater } from "@/lib/rate";
import { can } from "@/lib/roles";
import { LOGO_UPLOAD, planUpload } from "@/lib/upload";

/** Upload plans per workspace and hour (rule 3611). */
const PLANS_PER_HOUR = 30;

/**
 * POST /api/account/logo/upload {contentType, size} (rule 3611): plan one logo upload for the signed-in workspace, for an
 * owner or an admin only (`workspace.logo`). Answers `{mode: "signed", ...grant}` when the storage backend can sign (an
 * S3 bucket, rule 3615; the browser sends the bytes there, then posts `{name}` to `/api/account/logo`), else
 * `{mode: "server"}`. The object name and the owner (`w:{aid}` of the session's account) are the server's: nothing from
 * the request but the declared type and size, checked against the logo policy here and again on the bytes.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!can(u, "workspace.logo")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const aid = aidOf(u);
  if (!(await allow(accountKey.logoPlanBucket(aid), PLANS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => ({}))) as { contentType?: unknown; size?: unknown };
  const r = await planUpload(accountKey.logoUploadOwner(aid), LOGO_UPLOAD, { contentType: b.contentType, size: b.size });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "too_large" ? 413 : r.error === "bad_type" ? 415 : 400 });
  return NextResponse.json({ ok: true, ...r.plan });
}
