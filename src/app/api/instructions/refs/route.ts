import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { listFileNames } from "@/lib/files";
import { refRecords, refsAvailable } from "@/lib/instruction-refs";

/**
 * GET -> `{ ok, available, refs: [{ name, source: "gdocs" | "gsheets", title, at, exists }] }`: the Docs and Sheets this
 * workspace imported as reference files, newest first, read from `skillrefs:{sc(u)}` (rules 955-956). `exists` is whether
 * the file is still in the workspace (a Refresh of one that is gone becomes a new import). `available` is whether an
 * import can run now: Composio is on for `google_workspace` and a Docs or Sheets login is stored for this workspace;
 * the page hides Import when it is false. Any login of the account may read (like GET /api/instructions); the
 * workspace is `sc(u)` and nothing in the request names a key. No Google call is made.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const scope = sc(u);
  const [records, names, available] = await Promise.all([refRecords(scope), listFileNames(scope), refsAvailable(scope)]);
  const have = new Set(names);
  const refs = Object.entries(records)
    .map(([name, r]) => ({ name, source: r.source, title: r.title, at: r.at, exists: have.has(name) }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name));
  return NextResponse.json({ ok: true, available, refs });
}
