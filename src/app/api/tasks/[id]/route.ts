import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { addPreference, getTask, saveTask } from "@/lib/brand";
import { getGov } from "@/lib/governance";
import { readFile, writeFile } from "@/lib/files";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const t = await getTask(sc(u), id);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { status?: string; editedBody?: string; note?: string; scheduledFor?: string | null };
  if (b.scheduledFor === null) delete t.scheduledFor;
  else if (typeof b.scheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.scheduledFor)) t.scheduledFor = b.scheduledFor;
  const gov = await getGov(sc(u));
  const learn = async (note: string) => {
    if (!gov.learning) return;
    await addPreference(sc(u), note);
    const f = await readFile(sc(u), "preferences.md");
    await writeFile(sc(u), "preferences.md", `${f?.content ?? "# Preferences learned from the owner\n"}\n- ${new Date().toISOString().slice(0, 10)}: ${note}`.slice(-20000), "noor");
  };
  if (typeof b.editedBody === "string" && b.editedBody !== t.body) {
    t.editedBody = b.editedBody.slice(0, 20000);
    await learn(`Owner edited a ${t.type} item (${t.channel}). ${b.note ? "Reason: " + b.note : "Prefer this style: " + b.editedBody.slice(0, 200)}`);
  }
  if (b.status === "approved" || b.status === "rejected" || b.status === "pending") {
    t.status = b.status;
    if (b.status === "rejected" && b.note) await learn(`Owner rejected a ${t.type} item (${t.channel}). Reason: ${b.note}`);
  }
  await saveTask(sc(u), t);
  return NextResponse.json({ ok: true, task: t });
}
