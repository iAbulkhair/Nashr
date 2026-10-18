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
import { db } from "@/lib/db";
import { taskVersion } from "@/lib/task-version";
import { acct } from "@/lib/account-id";

type Patch = { status?: string; editedBody?: string; note?: unknown; scheduledFor?: string | null; version?: unknown };

/** The longest reason a person may give for an edit or a rejection. */
const NOTE_MAX = 300;
/**
 * The typed reason as it is stored: a string or nothing, on one line, without control or direction characters, at most
 * `NOTE_MAX` characters. Any member may reject (role "drafts"), and the reason lands in preferences.md, a core file every
 * agent reads, so it is the member's words inside a fixed sentence, never a block of text or a new markdown section.
 */
function cleanNote(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX).trim();
}

/** Learned notes are appended to preferences.md one request at a time: two rejections at once must not drop one. */
const PREFS_LOCK_S = 10;
async function appendPreferences(scope: string, lines: string) {
  const key = `prefsfile:${scope}`;
  let token: string | null = null;
  // Waiting for the lock is the one awaited call that repeats, as in updateTask (src/lib/brand.ts): ~3 s at most.
  for (let i = 0; i < 60 && !token; i++) {
    token = await db.lockOwned(key, PREFS_LOCK_S);
    if (!token) await new Promise((r) => setTimeout(r, 50));
  }
  if (!token) throw new Error("prefs_lock_timeout");
  try {
    const f = await readFile(scope, "preferences.md");
    await writeFile(scope, "preferences.md", `${f?.content ?? "# Preferences learned from the owner\n"}\n${lines}`.slice(-20000), "noor");
  } finally {
    await db.unlockOwned(key, token).catch((e) => console.error("prefs lock release failed", e instanceof Error ? e.name : "error"));
  }
}

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
  const gate = { refused: false, missing: false, changed: false };
  // Who decides is worked out from the session's actor (`byOf`), never from the body.
  const [raw, gov, brand, by] = await Promise.all([req.json().catch(() => ({})) as Promise<Patch>, getGov(scope), getBrand(scope), byOf(u)]);
  const b: Patch = raw && typeof raw === "object" ? raw : {};
  const note = cleanNote(b.note);

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
    // An approval covers the words the approver saw (src/lib/task-version.ts): a request that ends approved by approving
    // or by rewriting, or that says "approved", carries the version of the card it was made from, and it must still be
    // the item's version now, read under the task lock. Otherwise a member's edit made after the admin opened the card
    // would be approved, and later published, under the admin's name. Nothing is saved; the card reloads.
    if (need === "publish" || b.status === "approved") {
      if (typeof b.version !== "string") gate.missing = true;
      else if (b.version !== taskVersion(t)) gate.changed = true;
      if (gate.missing || gate.changed) return null;
    }
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
  if (gate.missing) return NextResponse.json({ ok: false, error: "version_required" }, { status: 400 });
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
