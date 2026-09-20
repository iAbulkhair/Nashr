import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { FileLimitError, MAX_FILES, deleteFile, listFiles, readFile, writeFile } from "@/lib/files";
import { allow } from "@/lib/rate";

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const name = new URL(req.url).searchParams.get("name");
  if (name) return NextResponse.json({ ok: true, file: await readFile(sc(u), name) });
  return NextResponse.json({ ok: true, files: await listFiles(sc(u)) });
}
/** A file is capped at 40,000 characters by writeFile; this rejects an oversized body before it is parsed. */
const MAX_BODY_BYTES = 200_000;

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Every other write in the codebase is throttled; this one was not, so one account could sit in a loop creating
  // files until its index was unusable for everyone reading it.
  if (!(await allow(`files:${sc(u)}`, 60, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const b = (await req.json().catch(() => ({}))) as { name?: string; content?: string };
  if (!b.name || typeof b.content !== "string") return NextResponse.json({ ok: false, error: "missing" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, file: await writeFile(sc(u), b.name, b.content, "user") });
  } catch (e) {
    if (e instanceof FileLimitError) return NextResponse.json({ ok: false, error: "file_limit", limit: MAX_FILES }, { status: 409 });
    throw e;
  }
}
export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return NextResponse.json({ ok: false }, { status: 400 });
  await deleteFile(sc(u), name);
  return NextResponse.json({ ok: true });
}
