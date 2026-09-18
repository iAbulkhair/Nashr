import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getTask, saveTask } from "@/lib/brand";
import { publishTask, targetsFor } from "@/lib/connectors/publish";
import { listConnections } from "@/lib/connectors/store";

export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const t = await getTask(sc(u), id);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { provider?: string };
  if (!b.provider) return NextResponse.json({ ok: false, error: "provider_required" }, { status: 400 });
  // The owner's click is the approval here, but a rejected item stays unpublished and the target must fit the item type.
  if (t.status === "rejected") return NextResponse.json({ ok: false, error: "rejected_item" }, { status: 409 });
  const connected = (await listConnections(sc(u))).map((c) => c.provider);
  if (!targetsFor(t, connected).includes(b.provider)) return NextResponse.json({ ok: false, error: "wrong_target" }, { status: 400 });
  try {
    const r = await publishTask(sc(u), t, b.provider);
    t.published = [...(t.published ?? []), { provider: r.provider, url: r.url, status: r.status, at: new Date().toISOString() }];
    t.status = "approved";
    await saveTask(sc(u), t);
    await track(u.email, "publish");
    return NextResponse.json({ ok: true, result: r, task: t });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "publish_failed" }, { status: 502 });
  }
}
