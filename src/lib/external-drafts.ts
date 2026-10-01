/**
 * Drafts written by the owner's own assistant (Claude, ChatGPT or any MCP client) and saved into the approval inbox
 * through the MCP tool `save_draft`. Free: no credits and no model call, because the owner's own subscription did the
 * writing. The inbox, the brand gate and the owner's approval are what Nashr adds.
 *
 * The text arrives from an outside model the owner steers, so it is untrusted input: every field is typed, trimmed and
 * bounded here, the storage scope is the authenticated caller's (`sc(u)`), never a value from the arguments, and the
 * item is always created `pending`, even when the owner auto-approves that type. The brand gate runs in code on save
 * (`gateTask`, the same check the approve and publish routes apply) and its result is returned to the caller; an item
 * that breaks a rule is kept, held in the inbox with the rule named, exactly like an agent's draft, so the owner can
 * edit it rather than lose it.
 */
import { randomBytes } from "crypto";
import { sc, type User } from "./auth";
import { briefOf, getBrand, saveTask, type Task } from "./brand";
import { explain, gateTask, initialStatus, isCustomerFacing, type Violation } from "./brand-rules";
import { draftAllowed } from "./rate";
import { isTaskType, type TaskType } from "./tasks";
import { tokenBy } from "./actor";
import { recordActivity } from "./activity";

export const DRAFT_LIMITS = { title: 200, body: 20000, notes: 500, channel: 30 } as const;

export type DraftInput = { type: TaskType; channel: string; title: string; body: string; notes?: string; lang?: "ar" | "en" };

// Control characters other than tab and new line carry nothing a reader needs and can hide text from the owner.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim() : "");

/** Validate the tool's arguments. Too long is refused, not cut: a silently truncated draft is a different draft. */
export function parseDraft(args: Record<string, unknown>): { ok: true; draft: DraftInput } | { ok: false; error: string } {
  if (!isTaskType(args.type)) return { ok: false, error: "Unknown or missing `type`: use one of the Thakeen item types (for example social, article, whatsapp, ads, gbp)." };
  const type = args.type;
  const body = clean(args.body);
  if (!body) return { ok: false, error: "Nothing to save: pass the draft text in `body`." };
  if (body.length > DRAFT_LIMITS.body) return { ok: false, error: `The draft is too long: ${body.length} characters, the limit is ${DRAFT_LIMITS.body}.` };
  let title = clean(args.title).replace(/\s+/g, " ");
  if (title.length > DRAFT_LIMITS.title) return { ok: false, error: `The title is too long: the limit is ${DRAFT_LIMITS.title} characters.` };
  if (!title) title = body.split("\n")[0].replace(/\s+/g, " ").slice(0, 80);
  const rawChannel = clean(args.channel).toLowerCase();
  if (rawChannel && !new RegExp(`^[a-z0-9_-]{1,${DRAFT_LIMITS.channel}}$`).test(rawChannel)) return { ok: false, error: "`channel` must be a short name such as instagram, snapchat, tiktok, x, whatsapp or blog." };
  const notes = clean(args.notes);
  if (notes.length > DRAFT_LIMITS.notes) return { ok: false, error: `The notes are too long: the limit is ${DRAFT_LIMITS.notes} characters.` };
  if (args.lang !== undefined && args.lang !== "ar" && args.lang !== "en") return { ok: false, error: "`lang` must be ar or en." };
  return { ok: true, draft: { type, channel: rawChannel || type, title, body, ...(notes ? { notes } : {}), ...(args.lang ? { lang: args.lang as "ar" | "en" } : {}) } };
}

export type SaveDraftResult =
  | { ok: true; task: Task; violations: Violation[] }
  | { ok: false; reason: "rate" | "no_brand" };

/** Save one external draft as a pending inbox item of the caller's active brand. No credits, no model call. */
export async function saveExternalDraft(user: User, d: DraftInput): Promise<SaveDraftResult> {
  // Per account, not per brand: switching brands must not multiply the allowance.
  if (!(await draftAllowed(user.email))) return { ok: false, reason: "rate" };
  const scope = sc(user);
  const brand = await getBrand(scope);
  if (!brand) return { ok: false, reason: "no_brand" };
  const brief = briefOf(d.notes);
  // The channel decides whether a personalisation slot such as {{1}} may stay (brand-rules.ts), as on the approve route.
  const draft = { type: d.type, channel: d.channel, title: d.title, body: d.body };
  const violations = gateTask(brand, draft);
  const t: Task = {
    id: randomBytes(8).toString("hex"), type: d.type, channel: d.channel, title: d.title, body: d.body,
    // Never auto-approved: the owner did not see this text in Nashr yet, so auto-approval is off for this path.
    status: initialStatus(false, brand, draft),
    createdAt: new Date().toISOString(), lang: d.lang ?? brand.languages[0] ?? "ar", source: "external", ...(brief ? { brief } : {}),
  };
  // One activity row, with no agent: no Nashr agent wrote it. The title is the outside model's text, kept as a note.
  await Promise.all([
    saveTask(scope, t, true),
    recordActivity(scope, [{ at: t.createdAt, kind: "external_draft", by: tokenBy(user), via: "mcp", type: t.type, tasks: [t.id], count: 1, note: t.title }]),
  ]);
  return { ok: true, task: t, violations };
}

/** The tool's answer: what was saved, and whether the brand gate will hold it at approval. */
export function draftReport(t: Task, violations: Violation[]) {
  return {
    saved: true, id: t.id, status: t.status, type: t.type, channel: t.channel, title: t.title,
    brandCheck: { pass: violations.length === 0, checkedAs: isCustomerFacing(t.type) ? "customer-facing" : "internal (not held)", violations, summary: explain(violations) },
    next: violations.length
      ? `Saved as pending, but the owner cannot approve or publish it until the text is edited: ${[violations.some((v) => v.kind === "banned") && "it contains a banned word", violations.some((v) => v.kind === "placeholder") && "it has an unfilled placeholder (fill it in; {{1}}-style slots pass only on whatsapp, email, sms and call drafts)"].filter(Boolean).join(", and ")}. Fix the draft and save it again, or tell the owner which rule fired.`
      : "Saved as pending in the approvals inbox. The owner approves, edits or rejects it there; nothing is published until they do.",
    credits: 0,
  };
}
