import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getTask, saveTask } from "@/lib/brand";
import { publishTask } from "@/lib/connectors/publish";

export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const t = await getTask(u.email, id);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { provider?: string };
  if (!b.provider) return NextResponse.json({ ok: false, error: "provider_required" }, { status: 400 });
  try {
    const r = await publishTask(u.email, t, b.provider);
    t.published = [...(t.published ?? []), { provider: r.provider, url: r.url, status: r.status, at: new Date().toISOString() }];
    t.status = "approved";
    await saveTask(u.email, t);
    return NextResponse.json({ ok: true, result: r, task: t });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "publish_failed" }, { status: 502 });
  }
}
