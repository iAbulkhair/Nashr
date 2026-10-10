import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { diffSets, getLayer, listHistory } from "@/lib/instructions-store";

/**
 * GET -> `{ ok, history }`: this workspace's versions, newest first. Open to every member.
 * GET `?compare=<revisionId>` -> `{ ok, history, diff }` with `diff = diffSets(revision.after, live set)`: what changed
 * since that version. The id is matched against the workspace's own history list and never used to build a key; one that is
 * not in it is 404 `not_found`.
 */
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const compare = new URL(req.url).searchParams.get("compare");
  const [history, layer] = await Promise.all([listHistory(sc(u)), compare === null ? null : getLayer(sc(u))]);
  if (compare === null || !layer) return NextResponse.json({ ok: true, history });
  const rev = history.find((r) => r.id === compare);
  if (!rev) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, history, diff: diffSets(rev.after, layer.active) });
}
