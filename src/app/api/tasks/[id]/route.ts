import { track } from "@/lib/track";
import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { addPreference, getBrand, updateTask } from "@/lib/brand";
import { gateTask, type Violation } from "@/lib/brand-rules";
import { getGov } from "@/lib/governance";
import { decisionOf, recordDecisions, type DecisionAction } from "@/lib/decisions";
import { editPctOf } from "@/lib/similarity";
import { byOf } from "@/lib/actor";
import { can, forbid } from "@/lib/roles";
import { appendPreferences, cleanNote } from "@/lib/task-notes";
import { taskVersion } from "@/lib/task-version";
import { acct } from "@/lib/account-id";

type Patch = { status?: string; editedBody?: string; note?: unknown; scheduledFor?: string | null; version?: unknown; notNow?: unknown; comment?: unknown };

/** Rule 3758: a comment is plain text, kept to 1,000 characters, and an item keeps its newest 50. */
const COMMENT_MAX = 1000;
const COMMENTS_KEPT = 50;
const cleanComment = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const text = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, COMMENT_MAX);
  return text || null;
};
const only = (b: object, allowed: readonly string[]) => Object.keys(b).every((k) => allowed.includes(k));

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const scope = sc(u);
  // An Editor (and up) may edit, reject, reopen and reschedule a draft (src/lib/roles.ts "drafts"). An item that ENDS
  // approved needs "approve" (rule 3760: admin or owner, or a member the owner or an admin let approve): approving it, or
  // changing the text of an item that stays approved, because an approved item is what gets published and the approval
  // must cover the words that go out. The check runs inside the task lock below, on the task as stored now, so an
  // approval landing mid-request is judged correctly. A Viewer (rule 3757) may only comment, and decide (approve or
  // reject, with a note) when allowed to approve: any other field from a viewer is refused before anything is read.
  const no = forbid(u, "comment");
  if (no) return no;
  const gate = { refused: false, missing: false, changed: false, notPending: false };
  // Who decides is worked out from the session's actor (`byOf`), never from the body.
  const [raw, gov, brand, by] = await Promise.all([req.json().catch(() => ({})) as Promise<Patch>, getGov(scope), getBrand(scope), byOf(u)]);
  const b: Patch = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const note = cleanNote(b.note);
  const comment = cleanComment(b.comment);
  const commentOnly = comment !== null && only(b, ["comment"]);
  if ("comment" in b && !commentOnly) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const decisionOnly = (b.status === "approved" || b.status === "rejected") && only(b, ["status", "note", "version"]);
  const edits = can(u, "drafts");
  if (!edits && !commentOnly) {
    const refused = decisionOnly ? forbid(u, "approve") : forbid(u, "drafts");
    if (refused) return refused;
  }
  const pid = u.actor?.pid;

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
    // A comment changes nothing that is published or decided (no version, no decision record): it is added and kept.
    if (commentOnly) {
      if (!pid) { gate.refused = true; return null; }
      t.comments = [...(Array.isArray(t.comments) ? t.comments : []), { pid, name: (u.actor?.name ?? "").slice(0, 80), text: comment!, at: now }].slice(-COMMENTS_KEPT);
      return t;
    }
    const ends = b.status === "approved" || b.status === "rejected" || b.status === "pending" ? b.status : t.status;
    const rewrites = typeof b.editedBody === "string" && b.editedBody !== t.body && b.editedBody.slice(0, 20000) !== (t.editedBody ?? t.body);
    // A viewer reaches here only with a pure decision, which needs "approve" either way.
    const need = (ends === "approved" && (t.status !== "approved" || rewrites)) || !edits ? "approve" : "drafts";
    if (!can(u, need)) {
      gate.refused = true;
      return null;
    }
    // An approval covers the words the approver saw (src/lib/task-version.ts): a request that ends approved by approving
    // or by rewriting, or that says "approved", carries the version of the card it was made from, and it must still be
    // the item's version now, read under the task lock. Otherwise a member's edit made after the admin opened the card
    // would be approved, and later published, under the admin's name. Nothing is saved; the card reloads.
    if ((ends === "approved" && need === "approve") || b.status === "approved") {
      if (typeof b.version !== "string") gate.missing = true;
      else if (b.version !== taskVersion(t)) gate.changed = true;
      if (gate.missing || gate.changed) return null;
    }
    // Rule 2440: a text edit carries the version of the card it was made from (the inbox sends it with every change), and
    // is saved only while that is still the item's version, so a member's edit never silently replaces another person's
    // or an agent's newer text. An edit without a version (an older page) is saved as before: expand step, rule 679.
    if (rewrites && typeof b.version === "string" && b.version !== taskVersion(t)) {
      gate.changed = true;
      return null;
    }
    // A person acting on the item without deciding it restarts its "Not now" clock (rule 2345, src/lib/not-now.ts).
    const touched = b.scheduledFor === null || (typeof b.scheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.scheduledFor)) || (typeof b.editedBody === "string" && b.editedBody !== t.body);
    if (b.scheduledFor === null) delete t.scheduledFor;
    else if (typeof b.scheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.scheduledFor)) t.scheduledFor = b.scheduledFor;
    if (typeof b.editedBody === "string" && b.editedBody !== t.body) {
      const before = t.editedBody ?? t.body;
      t.editedBody = b.editedBody.slice(0, 20000);
      notes.push(`Owner edited a ${t.type} item (${t.channel}). ${note ? "Reason: " + note : "Prefer this style: " + b.editedBody.slice(0, 200)}`);
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
      if (b.status === "rejected" && note) notes.push(`Owner rejected a ${t.type} item (${t.channel}). Reason: ${note}`);
    }
    // "Not now" (rule 2345): set aside or brought back, only while pending, by any member who may handle drafts. It is no
    // decision: no decidedAt, no decision record, nothing learned. A decision or a reopen takes the item out of "Not now".
    if (b.notNow === true || b.notNow === false) {
      if (t.status !== "pending") { gate.notPending = true; return null; }
      if (b.notNow) t.notNow = { at: now, by: "owner" };
      else { delete t.notNow; t.touchedAt = now; }
    } else if (b.status === "approved" || b.status === "rejected" || b.status === "pending") {
      if (t.notNow) t.touchedAt = now;
      delete t.notNow;
    }
    if (touched || (b.status === "pending" && decided.some((d) => d.action === "reopen"))) t.touchedAt = now;
    // An admin or owner who rewrites an item that stays approved has decided it (the role check above needed "approve"):
    // an item only auto-approval had passed becomes theirs, so the judge's veto and the chat's "nobody reviewed it" no
    // longer apply to it (src/lib/judge.ts, chat.ts publish_item).
    if (t.status === "approved" && rewrites && !t.decidedAt) t.decidedAt = now;
    // Rule 3761: who approved the words that will go out. Set by an approval or a rewrite of an approved item (both
    // needed "approve" above), cleared when the item leaves approved; `publishOnce` checks it under the approval policy.
    if (t.status === "approved" && (decided.some((d) => d.action === "approve") || rewrites)) {
      if (pid) t.approvedBy = { pid, at: now };
      else delete t.approvedBy;
    } else if (t.status !== "approved") delete t.approvedBy;
    // The brand file's rules are checked here, in code: an item whose final text breaks one cannot end up approved,
    // whether the owner clicked approve, saved an edit of an approved item, or the model asked for it. Nothing is saved,
    // so the card keeps its state and the owner sees which rule fired.
    if (t.status === "approved") {
      violations = gateTask(brand, t);
      if (violations.length) return null;
    }
    return t;
  });
  if (gate.refused) return forbid(u, "approve") ?? NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (gate.missing) return NextResponse.json({ ok: false, error: "version_required" }, { status: 400 });
  if (gate.notPending) return NextResponse.json({ ok: false, error: "not_pending", task: t }, { status: 409 });
  // The item as stored now goes back, so the card shows what changed before anyone decides again.
  if (gate.changed) return NextResponse.json({ ok: false, error: "changed", task: t }, { status: 409 });
  if (violations.length) return NextResponse.json({ ok: false, error: "brand_violation", violations }, { status: 409 });
  // The owner's typed reason belongs to the rejection when there is one, else to the edit: one note, one record.
  const reasoned = decided.find((d) => d.action === "reject") ?? decided.find((d) => d.action === "edit");
  if (reasoned && note) reasoned.note = note;
  const records = decided.map((d) => decisionOf(t, d.action, now, { ...d, by }));

  const later = async () => {
    try {
      // One round of parallel writes. The decision records are kept whether or not learning is on: they are the
      // owner's own history, under the caller's scope only. Preference notes are written only when learning is on.
      await Promise.all([
        ...events.map((e) => track(acct(u), e)),
        recordDecisions(scope, records),
        ...(gov.learning ? notes.map((n) => addPreference(scope, n)) : []),
      ]);
      if (gov.learning && notes.length) await appendPreferences(scope, notes.map((n) => `- ${new Date().toISOString().slice(0, 10)}: ${n}`).join("\n"));
    } catch (e) {
      console.error("task patch follow-up failed", e);
    }
  };
  try { after(later); } catch { void later(); }
  return NextResponse.json({ ok: true, task: t });
}
