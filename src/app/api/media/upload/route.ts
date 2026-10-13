import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { DriveFail, keepInLibrary, type DriveError } from "@/lib/cloud-drives";

/**
 * POST multipart `file` -> `{ ok, url, name }`: one image from the person's device into the workspace's media library
 * (rule 1783). On an iPhone or iPad the file input opens the Files picker, which includes iCloud Drive: this is how
 * iCloud files reach Thakeen, since Apple offers no API for a web app to link iCloud Drive (rule 1787).
 *
 * Images only, at most 5 MB: the proxy buffers at most 6 MB of any request body and hands the route the rest cut short
 * (next.config.ts, rule 774), so a video cannot come this way. The bytes are judged by their magic numbers, never by the
 * name or the type the browser sent, and re-encoded as one JPEG under `sc(u)` (keepInLibrary). Any member
 * (`library.write`); 30 uploads an hour per workspace.
 */
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const UPLOADS_PER_HOUR = 30;
const STATUS: Partial<Record<DriveError, number>> = { too_large: 413, not_media: 415, library_full: 409, store_full: 503, no_store: 503 };

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "library.write");
  if (no) return no;
  if (!(await allow(`mupload:${sc(u)}`, UPLOADS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  // Multipart adds a few hundred bytes around the file; anything past this is refused before it is read.
  if (Number(req.headers.get("content-length") ?? 0) > UPLOAD_MAX_BYTES + 64 * 1024) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !file.size) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  if (file.size > UPLOAD_MAX_BYTES) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  try {
    const kept = await keepInLibrary(sc(u), Buffer.from(await file.arrayBuffer()), "image", "upload");
    return NextResponse.json({ ok: true, ...kept });
  } catch (e) {
    const code: DriveError = e instanceof DriveFail ? e.code : "upstream";
    return NextResponse.json({ ok: false, error: code }, { status: STATUS[code] ?? 502 });
  }
}
