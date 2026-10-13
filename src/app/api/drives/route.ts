import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid, type Action } from "@/lib/roles";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { DriveFail, QUERY_MAX, driveReady, drivesOf, exportToDrive, importFromDrive, isDrive, searchDrive, type DriveError } from "@/lib/cloud-drives";
import { deleteLibraryFile, listLibrary } from "@/lib/media/store";
import { storeConfigured } from "@/lib/media/config";

/**
 * The workspace's cloud drives and media library (rules 1775-1789, docs/system/flows.md section 75).
 *
 * GET -> `{ ok, drives: [{ id, connected }], library: [...], store }`: the drives that can be used now (Composio on for
 * the provider and its auth config set; a drive that cannot is not listed, so no button shows for it) and this
 * workspace's library files. Any member.
 *
 * POST `{ action: "search", drive, q }` | `{ action: "import", drive, id, name }` (`library.write`, any member) |
 * `{ action: "export", drive, url }` (`library.export`, any member, never while the founder impersonates). Every call
 * acts on the drive login stored for `sc(u)` and only on this workspace's own files; the query, id, name and URL are
 * arguments, never keys. Each action has its own hourly bucket per workspace (429 + Retry-After).
 *
 * DELETE `?name=` (`library.write`): one library file of this workspace; a post's own image or clip is never deleted here.
 */
const STATUS: Record<DriveError, number> = {
  not_connected: 409, bad_request: 400, unsupported: 415, too_large: 413, not_media: 422, not_text: 422, empty: 422,
  library_full: 409, files_full: 409, store_full: 503, no_store: 503, upstream: 502,
};
const fail = (e: unknown) => {
  const code: DriveError = e instanceof DriveFail ? e.code : "upstream";
  return NextResponse.json({ ok: false, error: code }, { status: STATUS[code] });
};

/** Per workspace and hour (rule 1785): browsing never uses up the imports, and an export is a write at the drive. */
const DRIVE_LIMITS = { search: 60, import: 30, export: 30, delete: 120 } as const;
const ROLE: Record<"search" | "import" | "export", Action> = { search: "library.write", import: "library.write", export: "library.export" };

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const [drives, library] = await Promise.all([drivesOf(sc(u), driveReady), listLibrary(sc(u))]);
  return NextResponse.json({ ok: true, drives, library, store: storeConfigured() });
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { action?: unknown; drive?: unknown; q?: unknown; id?: unknown; name?: unknown; url?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const action = b.action;
  if (action !== "search" && action !== "import" && action !== "export") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const no = forbid(u, ROLE[action]);
  if (no) return no;
  if (!isDrive(b.drive) || !driveReady(b.drive)) return NextResponse.json({ ok: false, error: "unknown_drive" }, { status: 404 });
  if (!(await allow(`drive:${action}:${sc(u)}`, DRIVE_LIMITS[action], WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  try {
    if (action === "search") {
      if (typeof b.q !== "string" || !b.q.trim() || b.q.length > QUERY_MAX) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
      return NextResponse.json({ ok: true, results: await searchDrive(sc(u), b.drive, b.q) });
    }
    if (action === "import") {
      if (typeof b.id !== "string" || typeof b.name !== "string") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
      return NextResponse.json({ ok: true, imported: await importFromDrive(sc(u), b.drive, b.id, b.name) });
    }
    if (typeof b.url !== "string") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    return NextResponse.json({ ok: true, saved: await exportToDrive(sc(u), b.drive, b.url) });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "library.write");
  if (no) return no;
  if (!(await allow(`drive:delete:${sc(u)}`, DRIVE_LIMITS.delete, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!(await deleteLibraryFile(sc(u), name))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
