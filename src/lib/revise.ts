import { trialOver, type User } from "./auth";
import { charge, personOf, refund, renewIfDue, renewalDue, type SpendRef } from "./credits";
import { fairUseGate } from "./fair-use";
import { agentForTask } from "./agents";
import { addPreference, getBrand, getTask, listPreferencesFor, updateTask, type Brand, type Task } from "./brand";
import { isDraftType, type TaskType } from "./tasks";
import { getGov } from "./governance";
import { modelState } from "./model";
import { modelAllowsTask, modelById } from "./models/catalog";
import { creditsFor } from "./models/credits";
import { generateRouteFor } from "./models/overrides";
import { memoryBlock } from "./files";
import { feedbackFor } from "./feedback";
import { reviseDraft, type LineNote } from "./noor";
import { warnAgentCap } from "./notifications";
import { entitlements } from "./entitlements";
import { byOf } from "./actor";
import { recordActivity, type Activity } from "./activity";
import { AgentScopeRefused, checkGenerationNotes, otherBrandNames, readAgentScopeModes, scopeCheck, type AgentScopeModes } from "./agent-scope";
import { taskVersion } from "./task-version";
import { appendPreferences, cleanNote } from "./task-notes";
import { draftCredits } from "./task-costs";
import { decisionOf, recordDecisions } from "./decisions";
import { editPctOf } from "./similarity";
import { acct } from "./account-id";
import { usageWho } from "./usage";
import { log } from "./log";
import type { Scope } from "./keys";
import type { Lang } from "./i18n";

/**
 * Line notes on a draft (rules 2490-2499; pattern 3 of docs/reports/2026-10-19-PRD-fizzy-orca_AR.md, after Orca's notes on diff
 * lines). The owner leaves a note on each line of a pending draft that should change, then sends them all at once: one model
 * call, one revised draft, one draft's price. The revision replaces the text the card shows (`editedBody`), the item stays
 * pending, and nothing is approved or published by it (rule 2495): the owner reads the new text and decides as before.
 *
 * Every check runs in code, in this order, and every refusal before the charge costs nothing: the item (the caller's scope
 * only, rule 2499), its type and state, the version the owner saw, the notes, the pause, the brand, the model, the trial, fair
 * use, the notes' scope gate, then the charge. A failure after the charge refunds it with its receipt (rule 2492).
 */

/** At most this many notes in one revision. */
export const REVISE_MAX_NOTES = 10;
/** The longest line text kept as a note's anchor. */
const QUOTE_MAX = 2000;
/** The longest revised body saved, as an edit in the inbox (PATCH /api/tasks/[id]). */
const BODY_MAX = 20000;

/** The lines a note points into: the text the card shows. */
export const linesOf = (t: Pick<Task, "body" | "editedBody">) => (t.editedBody ?? t.body).split("\n");

/**
 * The notes as the request sent them, checked against the lines they point to (rule 2491): an array of 1 to `REVISE_MAX_NOTES`
 * `{line, quote, note}`, `line` a whole number inside the text and not blank, `quote` exactly that line's text, `note` the
 * cleaned typed note (`cleanNote`: one line, no control or direction characters, at most 300), one note per line. Sorted by
 * line. Anything else is null: nothing is charged for a request the server cannot anchor.
 */
export function parseNotes(v: unknown, lines: readonly string[]): LineNote[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > REVISE_MAX_NOTES) return null;
  const seen = new Set<number>();
  const out: LineNote[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return null;
    const { line, quote, note } = raw as Record<string, unknown>;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 0 || line >= lines.length || seen.has(line)) return null;
    if (typeof quote !== "string" || quote !== lines[line] || !quote.trim()) return null;
    const text = cleanNote(note);
    if (!text) return null;
    seen.add(line);
    out.push({ line, quote: quote.slice(0, QUOTE_MAX), note: text });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The model a revision of this type runs on, exactly as a batch resolves it, when the catalog offers it for the type. */
function modelFor(user: User, brand: Pick<Brand, "model">, type: TaskType): string | null {
  const entry = modelById(generateRouteFor(user, brand, type).model);
  if (!entry || (!entry.auto && !entry.pick) || !modelAllowsTask(entry, type)) return null;
  return entry.id;
}

/**
 * One draft's price (rule 2492): `draftCredits(type, 1)` at the model's tier (`creditsFor`, rule 902), what the chat's one-item
 * draft costs. Null for a type that is not a draft type or a model the catalog does not offer for it. The inbox shows this
 * price on the send button; the charge below uses the same function.
 */
export function revisePrice(user: User, brand: Pick<Brand, "model">, type: TaskType): number | null {
  if (!isDraftType(type)) return null;
  const model = modelFor(user, brand, type);
  return model ? creditsFor(draftCredits(type, 1), model, "generate", type) : null;
}

export type ReviseRefusal =
  | { ok: false; reason: "not_found" | "not_revisable" | "version_required" | "bad_notes" | "paused" | "no_brand" | "trial_over" | "no_model" }
  | { ok: false; reason: "changed" | "not_pending"; task: Task; credits?: number }
  | { ok: false; reason: "fair_use"; resumes: string }
  | { ok: false; reason: "agent_cap"; agent: string; spent: number; cap: number; credits: number }
  | { ok: false; reason: "no_credits"; need: number; credits: number }
  | { ok: false; reason: "agent_scope"; message: string; credits?: number }
  | { ok: false; reason: "agent_scope_slow"; retry: "hour" | "day" }
  | { ok: false; reason: "failed"; error: unknown; credits: number };
export type ReviseDone = { ok: true; task: Task; credits: number; charged: number; later: () => Promise<void> };

export type ReviseOpts = { lang: Lang; deadline?: number; modes?: AgentScopeModes; slow?: "hour" | "day" | null };

/** The fixed sentence a learned note keeps (`listPreferencesFor` routes it to the type's agent by it). */
const learnedNote = (t: Task, notes: readonly LineNote[]) =>
  `Owner edited a ${t.type} item (${t.channel}). Reason: line notes: ${notes.map((n) => `"${n.note}"`).join("; ")}`.slice(0, 500);

export async function reviseTask(user: User, scope: Scope, id: string, input: { version?: unknown; notes?: unknown }, o: ReviseOpts): Promise<ReviseDone | ReviseRefusal> {
  const t = await getTask(scope, id);
  if (!t) return { ok: false, reason: "not_found" };
  if (!isDraftType(t.type)) return { ok: false, reason: "not_revisable" };
  if (t.status !== "pending") return { ok: false, reason: "not_pending", task: t };
  // The text the owner saw (rule 2491): a note anchors to a line of that text, so a request without it, or for text that has
  // changed since, is answered before anything is charged, with the item as it is now.
  if (typeof input.version !== "string") return { ok: false, reason: "version_required" };
  if (input.version !== taskVersion(t)) return { ok: false, reason: "changed", task: t };
  const notes = parseNotes(input.notes, linesOf(t));
  if (!notes) return { ok: false, reason: "bad_notes" };
  if (modelState() === "paused") return { ok: false, reason: "paused" };
  const [brand, gov, modes] = await Promise.all([getBrand(scope), getGov(scope), o.modes ?? readAgentScopeModes()]);
  if (!brand) return { ok: false, reason: "no_brand" };
  const model = modelFor(user, brand, t.type);
  if (!model) return { ok: false, reason: "no_model" };
  if (trialOver(user)) return { ok: false, reason: "trial_over" };
  const stop = await fairUseGate(user);
  if (stop) return { ok: false, reason: "fair_use", resumes: stop.resumes };
  const agent = agentForTask(t.type).id;
  // The notes are the owner's words, checked like a batch's notes (rule 796) before the charge: an enforced refusal charges nothing.
  const gate = await checkGenerationNotes(user, t.type, { notes: notes.map((n) => n.note).join("\n"), mode: modes.input, where: "revise", lang: o.lang, slow: o.slow }, brand, o.deadline).catch((e): { block: false } => {
    log.error("revise notes gate failed", e);
    return { block: false };
  });
  if (gate.block) return "slow" in gate ? { ok: false, reason: "agent_scope_slow", retry: gate.slow } : { ok: false, reason: "agent_scope", message: gate.reply };

  const cost = creditsFor(draftCredits(t.type, 1), model, "generate", t.type);
  const by = byOf(user);
  const row = (kind: Activity["kind"], extra: Partial<Activity> = {}): Activity => ({ at: new Date().toISOString(), kind, agent, by, via: "app", type: t.type, tasks: [t.id], credits: cost, ...extra });
  if (renewalDue(user)) await renewIfDue(acct(user));
  const paid = await charge(acct(user), cost, { scope, agent, cap: gov.agentCaps[agent], person: personOf(user) });
  if (!paid.ok && paid.reason === "agent_cap") {
    await recordActivity(scope, [row("cap_reached", { outcome: `${paid.spent}/${paid.cap}` })]);
    return { ok: false, reason: "agent_cap", agent: paid.agent, spent: paid.spent, cap: paid.cap, credits: paid.credits };
  }
  if (!paid.ok) {
    await recordActivity(scope, [row("no_credits")]);
    return { ok: false, reason: "no_credits", need: cost, credits: paid.credits };
  }
  user.credits = paid.credits;
  const receipt: SpendRef = paid;
  await warnAgentCap(user, paid);
  const back = () => refund(acct(user), cost, receipt);

  let saved: Task | null;
  const lost = { changed: false, notPending: false };
  const version = input.version;
  const now = new Date().toISOString();
  try {
    const [prefs, memory, feedback] = await Promise.all([listPreferencesFor(scope, agent), memoryBlock(scope), feedbackFor(scope, agent, { gov })]);
    const revised = await reviseDraft(t.type, brand, prefs, { channel: t.channel, title: t.title, body: t.editedBody ?? t.body }, notes, {
      model, meter: acct(user), meterWho: usageWho(user, scope), memory, feedback, noEmDash: gov.noEmDash, agentScope: modes.prompt === "on", deadline: o.deadline,
      instructions: { scope, limits: entitlements(user).instructions },
    });
    // The revised text is an agent's text, checked like a batch's items (rule 801): refused in enforce, logged in shadow.
    if (modes.output !== "off") {
      const otherBrands = await otherBrandNames(user).catch((e): string[] => {
        log.error("agent scope brand names failed", e);
        return [];
      });
      const d = await scopeCheck("output", modes.output, `${revised.title}\n\n${revised.body}`, { user, agent, where: "revise", lang: o.lang, brand: { name: brand.name, industry: brand.industry ?? "" }, otherBrands, itemId: t.id, deadline: o.deadline });
      if (d.block) throw new AgentScopeRefused(d.verdict, d.reply);
    }
    // Saved under the item's lock, on the item as stored now (rule 2494): decided or changed while the agent worked, nothing
    // is written and the charge goes back.
    saved = await updateTask(scope, id, (cur) => {
      if (cur.status !== "pending") { lost.notPending = true; return null; }
      if (taskVersion(cur) !== version) { lost.changed = true; return null; }
      cur.editedBody = revised.body.slice(0, BODY_MAX);
      cur.title = revised.title.slice(0, 80);
      cur.touchedAt = now;
      return cur;
    });
    if (!saved) throw new Error("not_found");
  } catch (error) {
    const credits = await back();
    user.credits = credits;
    if (error instanceof AgentScopeRefused) return { ok: false, reason: "agent_scope", message: error.reply, credits };
    return { ok: false, reason: "failed", error, credits };
  }
  if (lost.changed || lost.notPending) {
    const credits = await back();
    user.credits = credits;
    return { ok: false, reason: lost.changed ? "changed" : "not_pending", task: saved, credits };
  }

  const done = saved;
  // After the answer: the edit decision, the activity row and, when learning is on, the notes as a learned preference (rule 2496).
  const later = async () => {
    try {
      const learned = learnedNote(done, notes);
      await Promise.all([
        recordDecisions(scope, [decisionOf(done, "edit", now, { editPct: editPctOf(done.body, done.editedBody ?? done.body), note: notes.map((n) => n.note).join("; "), by })]),
        recordActivity(scope, [row("revised", { count: notes.length })]),
        ...(gov.learning ? [addPreference(scope, learned)] : []),
      ]);
      if (gov.learning) await appendPreferences(scope, `- ${now.slice(0, 10)}: ${learned}`);
    } catch (e) {
      log.error("revise follow-up failed", e);
    }
  };
  return { ok: true, task: done, credits: paid.credits, charged: cost, later };
}
