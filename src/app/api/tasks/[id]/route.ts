import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { addPreference, getTask, saveTask } from "@/lib/brand";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const t = await getTask(u.email, id);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { status?: string; editedBody?: string; note?: string };
  if (typeof b.editedBody === "string" && b.editedBody !== t.body) {
    t.editedBody = b.editedBody.slice(0, 20000);
    await addPreference(u.email, `Owner edited a ${t.type} item (${t.channel}). ${b.note ? "Reason: " + b.note : "Prefer this style: " + b.editedBody.slice(0, 200)}`);
  }
  if (b.status === "approved" || b.status === "rejected" || b.status === "pending") {
    t.status = b.status;
    if (b.status === "rejected" && b.note) await addPreference(u.email, `Owner rejected a ${t.type} item (${t.channel}). Reason: ${b.note}`);
  }
  await saveTask(u.email, t);
  return NextResponse.json({ ok: true, task: t });
}
