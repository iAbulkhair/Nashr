import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { personKey } from "@/lib/keys";
import { actingLogin } from "@/lib/own-password";
import { WINDOW, allow, retryLater } from "@/lib/rate";
import { AVATAR_UPLOAD, planUpload } from "@/lib/upload";

/** Upload plans per person and hour (rule 3501). */
const PLANS_PER_HOUR = 30;

/**
 * POST /api/account/avatar/upload {contentType, size} (rule 3501): plan one picture upload for the signed-in person.
 * Answers `{mode: "signed", name, url, method, headers, fields?, expiresAt}` when the storage backend can sign (the
 * browser sends the bytes there, then posts `{name}` to `/api/account/avatar`), else `{mode: "server"}` (the browser
 * posts the image itself to `/api/account/avatar`). The object name and the owner are the server's: nothing from the
 * request but the declared type and size, which are checked against the avatar policy here and again on the bytes.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!(await allow(personKey.avatarPlanBucket(me.pid), PLANS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => ({}))) as { contentType?: unknown; size?: unknown };
  const r = await planUpload(personKey.uploadOwner(me.pid), AVATAR_UPLOAD, { contentType: b.contentType, size: b.size });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "too_large" ? 413 : r.error === "bad_type" ? 415 : 400 });
  return NextResponse.json({ ok: true, ...r.plan });
}
