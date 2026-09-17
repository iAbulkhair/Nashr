import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { deleteFile, listFiles, readFile, writeFile } from "@/lib/files";

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const name = new URL(req.url).searchParams.get("name");
  if (name) return NextResponse.json({ ok: true, file: await readFile(sc(u), name) });
  return NextResponse.json({ ok: true, files: await listFiles(sc(u)) });
}
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { name?: string; content?: string };
  if (!b.name || typeof b.content !== "string") return NextResponse.json({ ok: false, error: "missing" }, { status: 400 });
  return NextResponse.json({ ok: true, file: await writeFile(sc(u), b.name, b.content, "user") });
}
export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return NextResponse.json({ ok: false }, { status: 400 });
  await deleteFile(sc(u), name);
  return NextResponse.json({ ok: true });
}
