import { track } from "@/lib/track";
import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { addPreference, getBrand, updateTask } from "@/lib/brand";
import { gateTask, type Violation } from "@/lib/brand-rules";
import { getGov } from "@/lib/governance";
import { readFile, writeFile } from "@/lib/files";
import { decisionOf, recordDecisions, type DecisionAction } from "@/lib/decisions";
import { editPctOf } from "@/lib/similarity";
import { byOf } from "@/lib/actor";
import { can, forbid } from "@/lib/roles";

type Patch = { status?: string; editedBody?: string; note?: string; scheduledFor?: string | null };

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const scope = sc(u);
  // Any member may edit, reject, reopen and reschedule a draft (src/lib/roles.ts "drafts"). An item that ENDS approved
  // needs admin or owner ("publish"): approving it, or changing the text of an item that stays approved, because an
  // approved item is what gets published and the approval must cover the words that go out. The publish check runs
  // inside the task lock below, on the task as stored now, so an approval landing mid-request is judged correctly.
  const no = forbid(u, "drafts");
  if (no) return no;
  const gate = { refused: false };
  // Who decides is worked out from the session's actor (`byOf`), never from the body.
  const [b, gov, brand, by] = await Promise.all([req.json().catch(() => ({})) as Promise<Patch>, getGov(scope), getBrand(scope), byOf(u)]);

  // What the owner waits for is the saved task. Preference learning, event tracking and the decision records are
  // collected here and run after the response.
  const notes: string[] = [];
  const events: ("approve" | "reject")[] = [];
  const now = new Date().toISOString();
  const decided: { action: DecisionAction; editPct?: number; note?: unknown }[] = [];
  let violations: Violation[] = [];
  // The owner's change is applied to the task as stored now, under the task lock: a render that finished while this
  // request was in flight keeps its image or clip (src/lib/brand.ts, updateTask).
  const t = await updateTask(scope, id, (t) => {
    const ends = b.status === "approved" || b.status === "rejected" || b.status === "pending" ? b.status : t.status;
    const rewrites = typeof b.editedBody === "string" && b.editedBody !== t.body && b.editedBody.slice(0, 20000) !== (t.editedBody ?? t.body);
    const need = ends === "approved" && (t.status !== "approved" || rewrites) ? "publish" : "drafts";
    if (!can(u, need)) {
      gate.refused = true;
      return null;
    }
    if (b.scheduledFor === null) delete t.scheduledFor;
    else if (typeof b.scheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.scheduledFor)) t.scheduledFor = b.scheduledFor;
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
    // An admin or owner who rewrites an item that stays approved has decided it (the role check above needed "publish"):
    // an item only auto-approval had passed becomes theirs, so the judge's veto and the chat's "nobody reviewed it" no
    // longer apply to it (src/lib/judge.ts, chat.ts publish_item).
    if (t.status === "approved" && rewrites && !t.decidedAt) t.decidedAt = now;
    // The brand file's rules are checked here, in code: an item whose final text breaks one cannot end up approved,
    // whether the owner clicked approve, saved an edit of an approved item, or the model asked for it. Nothing is saved,
    // so the card keeps its state and the owner sees which rule fired.
    if (t.status === "approved") {
      violations = gateTask(brand, t);
      if (violations.length) return null;
    }
    return t;
  });
  if (gate.refused) return forbid(u, "publish") ?? NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (violations.length) return NextResponse.json({ ok: false, error: "brand_violation", violations }, { status: 409 });
  // The owner's typed reason belongs to the rejection when there is one, else to the edit: one note, one record.
  const reasoned = decided.find((d) => d.action === "reject") ?? decided.find((d) => d.action === "edit");
  if (reasoned) reasoned.note = b.note;
  const records = decided.map((d) => decisionOf(t, d.action, now, { ...d, by }));

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
