import { track } from "@/lib/track";
import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { addPreference, getBrand, getTask, saveTask } from "@/lib/brand";
import { gateTask } from "@/lib/brand-rules";
import { getGov } from "@/lib/governance";
import { readFile, writeFile } from "@/lib/files";
import { decisionOf, recordDecisions, type DecisionAction } from "@/lib/decisions";
import { editPctOf } from "@/lib/similarity";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const scope = sc(u);
  const [t, gov, brand] = await Promise.all([getTask(scope, id), getGov(scope), getBrand(scope)]);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { status?: string; editedBody?: string; note?: string; scheduledFor?: string | null };
  if (b.scheduledFor === null) delete t.scheduledFor;
  else if (typeof b.scheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.scheduledFor)) t.scheduledFor = b.scheduledFor;

  // What the owner waits for is the saved task. Preference learning, event tracking and the decision records are
  // collected here and run after the response.
  const notes: string[] = [];
  const events: ("approve" | "reject")[] = [];
  const now = new Date().toISOString();
  const decided: { action: DecisionAction; editPct?: number; note?: unknown }[] = [];
  if (typeof b.editedBody === "string" && b.editedBody !== t.body) {
    const before = t.editedBody ?? t.body;
    t.editedBody = b.editedBody.slice(0, 20000);
    notes.push(`Owner edited a ${t.type} item (${t.channel}). ${b.note ? "Reason: " + b.note : "Prefer this style: " + b.editedBody.slice(0, 200)}`);
    // Saving the same text again (approving an edit made earlier) is not a new edit.
    if (t.editedBody !== before) decided.push({ action: "edit", editPct: editPctOf(t.body, t.editedBody) });
  }
  if (b.status === "approved" || b.status === "rejected" || b.status === "pending") {
    if (b.status !== t.status) {
      t.decidedAt = b.status === "pending" ? undefined : now;
      decided.push({ action: b.status === "approved" ? "approve" : b.status === "rejected" ? "reject" : "reopen" });
    }
    t.status = b.status;
    if (b.status === "approved") events.push("approve");
    if (b.status === "rejected") events.push("reject");
    if (b.status === "rejected" && b.note) notes.push(`Owner rejected a ${t.type} item (${t.channel}). Reason: ${b.note}`);
  }
  // The owner's typed reason belongs to the rejection when there is one, else to the edit: one note, one record.
  const reasoned = decided.find((d) => d.action === "reject") ?? decided.find((d) => d.action === "edit");
  if (reasoned) reasoned.note = b.note;
  // The brand file's rules are checked here, in code: an item whose final text breaks one cannot end up approved,
  // whether the owner clicked approve, saved an edit of an approved item, or the model asked for it. Nothing is saved,
  // so the card keeps its state and the owner sees which rule fired.
  if (t.status === "approved") {
    const violations = gateTask(brand, t);
    if (violations.length) return NextResponse.json({ ok: false, error: "brand_violation", violations }, { status: 409 });
  }
  await saveTask(scope, t);
  const records = decided.map((d) => decisionOf(t, d.action, now, d));

  const later = async () => {
    try {
      // One round of parallel writes. The decision records are kept whether or not learning is on: they are the
      // owner's own history, under the caller's scope only. Preference notes are written only when learning is on.
      await Promise.all([
        ...events.map((e) => track(u.email, e)),
        recordDecisions(scope, records),
        ...(gov.learning ? notes.map((n) => addPreference(scope, n)) : []),
      ]);
      if (gov.learning && notes.length) {
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
