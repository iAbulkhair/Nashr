import { track } from "@/lib/track";
import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { addPreference, getTask, saveTask } from "@/lib/brand";
import { getGov } from "@/lib/governance";
import { readFile, writeFile } from "@/lib/files";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const scope = sc(u);
  const [t, gov] = await Promise.all([getTask(scope, id), getGov(scope)]);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { status?: string; editedBody?: string; note?: string; scheduledFor?: string | null };
  if (b.scheduledFor === null) delete t.scheduledFor;
  else if (typeof b.scheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.scheduledFor)) t.scheduledFor = b.scheduledFor;

  // What the owner waits for is the saved task. Preference learning and event tracking are collected here and run after the response.
  const notes: string[] = [];
  const events: ("approve" | "reject")[] = [];
  if (typeof b.editedBody === "string" && b.editedBody !== t.body) {
    t.editedBody = b.editedBody.slice(0, 20000);
    notes.push(`Owner edited a ${t.type} item (${t.channel}). ${b.note ? "Reason: " + b.note : "Prefer this style: " + b.editedBody.slice(0, 200)}`);
  }
  if (b.status === "approved" || b.status === "rejected" || b.status === "pending") {
    if (b.status !== t.status) t.decidedAt = b.status === "pending" ? undefined : new Date().toISOString();
    t.status = b.status;
    if (b.status === "approved") events.push("approve");
    if (b.status === "rejected") events.push("reject");
    if (b.status === "rejected" && b.note) notes.push(`Owner rejected a ${t.type} item (${t.channel}). Reason: ${b.note}`);
  }
  await saveTask(scope, t);

  const later = async () => {
    try {
      for (const e of events) await track(u.email, e);
      if (gov.learning && notes.length) {
        for (const n of notes) await addPreference(scope, n);
        const f = await readFile(scope, "preferences.md");
        const lines = notes.map((n) => `- ${new Date().toISOString().slice(0, 10)}: ${n}`).join("\n");
        await writeFile(scope, "preferences.md", `${f?.content ?? "# Preferences learned from the owner\n"}\n${lines}`.slice(-20000), "noor");
      }
    } catch (e) {
      console.error("task patch follow-up failed", e);
    }
  };
  try { after(later); } catch { void later(); }
  return NextResponse.json({ ok: true, task: t });
}
