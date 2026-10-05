"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { AgendaBucket, SecRepeat } from "@/lib/secretary-agenda";
import AwayPanel, { type AwayRow } from "./AwayPanel";
import Scribble from "@/components/Scribble";

/**
 * One item as the page shows it: every date already formatted on the server, in the brand's zone. `proposed.claim` is
 * an agent's words, attributed to it; `fact` is what code read about the linked inbox item ("" when there is none).
 */
export type TodoRow = {
  id: string; rev: number; title: string; description: string;
  due: string | null; dueLocal: string | null; who: string; next: string; badges: string[];
  /** Someone else owes it: the row offers "Followed up". `chase`: when it is expected, and the last follow-up. */
  theirs: boolean; chase: string;
  proposed: { claim: string } | null; fact: string; result: string | null; notes: string[];
  /** The reminder as the owner reads it ("at" only while timed reminders run), and its datetime-local value. */
  remind: string | null; remindLocal: string | null;
  /** A they-owe item's contact number (the owner's own page only), and its wa.me link with a fixed message. */
  phone: string | null; whatsapp: string | null;
  /**
   * Why the chase rule holds the item back while it waits (the contact's absence, a quiet day, Ramadan's hours; spec
   * §2.2, ruling R9), shown under the WhatsApp link. Absent when nothing holds it back.
   */
  reason?: string;
  /** The contact who owes an open item (not the owner, not an agent): the row offers "Away until…" with this name. */
  contact?: string | null;
  /** A recurring copy: its rule in words ("Repeats every week on Sunday"), the rule's fields for the form, the series id (the history link on a closed copy) and, on a closed copy, who closed it. */
  repeat: string | null; repeatRule: RepeatRule | null; seriesId: string | null; closedBy: string | null;
};
/** The fields of a rule the form starts from; `until` is "" when there is none. */
export type RepeatRule = { every: SecRepeat["every"]; interval: number; weekdays: number[]; monthDay: number | null; until: string; count: number | null; remindBefore: number | null };
/** A rule being typed: `every` "" means no repeat (the add form's start). Numbers stay text until sent. */
type RuleForm = { every: "" | SecRepeat["every"]; interval: string; weekdays: number[]; monthDay: string; last: boolean; until: string; count: string; remindBefore: string };
const EMPTY_RULE: RuleForm = { every: "", interval: "", weekdays: [], monthDay: "", last: false, until: "", count: "", remindBefore: "" };
const EVERY: SecRepeat["every"][] = ["day", "workday", "week", "month", "year", "hmonth", "hyear"];
/** The form a row's rule fills in; a row without one starts at "every day". */
const ruleForm = (r: RepeatRule | null): RuleForm => (r
  ? { every: r.every, interval: String(r.interval), weekdays: r.weekdays, monthDay: r.monthDay !== null && r.monthDay > 0 ? String(r.monthDay) : "", last: r.monthDay === -1, until: r.until, count: r.count === null ? "" : String(r.count), remindBefore: r.remindBefore === null ? "" : String(r.remindBefore) }
  : { ...EMPTY_RULE, every: "day" });
/** The rule as the routes take it (`parseRepeat` checks every range); a field the rule does not use is left out. */
function ruleBody(f: RuleForm): Record<string, unknown> | null {
  if (!f.every) return null;
  const body: Record<string, unknown> = { every: f.every };
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  if (f.every !== "workday" && num(f.interval) !== undefined) body.interval = num(f.interval);
  if (f.every === "week" && f.weekdays.length) body.weekdays = [...f.weekdays].sort((a, b) => a - b);
  if (f.every === "month" || f.every === "hmonth") { if (f.last) body.monthDay = -1; else if (num(f.monthDay) !== undefined) body.monthDay = num(f.monthDay); }
  if (f.until) body.until = f.until;
  if (num(f.count) !== undefined) body.count = num(f.count);
  if (num(f.remindBefore) !== undefined) body.remindBefore = num(f.remindBefore);
  return body;
}
export type TodoSection = { bucket: AgendaBucket; title: string; rows: TodoRow[] };
type Panel = { id: string; kind: "done" | "snooze" | "reschedule" | "remind" | "phone" | "repeat" } | null;
const UNDO_MS = 8000;
/**
 * One card of "Walk me through" (GET/POST /api/secretary/walk). Its buttons call the item's own routes. A confirm card
 * carries the agent's claim and what the app checked; an approval card the draft's opening and, when the brand guard
 * holds it, why (and no Approve). All plain text, rendered as text.
 */
type WalkCard = {
  key: string; kind: "todo" | "approval"; id: string; title: string; line: string; actions: ("done" | "confirm" | "not_yet" | "snooze" | "chased" | "approve" | "open")[];
  claim?: { by: string; text: string }; fact?: string; excerpt?: string; held?: string;
  /** An approval card: the version of the draft it shows (src/lib/task-version.ts), sent with Approve. */
  version?: string;
};

/**
 * A repeat rule's fields: selects, number inputs and checkboxes (no time-of-day input: the time comes from the due time,
 * and there are no switches). `none` adds "Does not repeat" (the add form); the number fields appear only for the
 * cadences that use them.
 */
function RepeatFields({ T, value, onChange, none, id }: { T: AppDict["todo"]; value: RuleForm; onChange: (v: RuleForm) => void; none: boolean; id: string }) {
  const R = T.repeat;
  const set = (patch: Partial<RuleForm>) => onChange({ ...value, ...patch });
  const on = value.every;
  return (
    <>
      <label className="text-xs text-ink/70">{R.every}
        <select value={on} onChange={(e) => set({ every: e.target.value as RuleForm["every"] })} className="input mt-1" id={`${id}-every`}>
          {none && <option value="">{R.none}</option>}
          {EVERY.map((e) => <option key={e} value={e}>{R.units[e]}</option>)}
        </select>
      </label>
      {on && on !== "workday" && (
        <label className="text-xs text-ink/70">{R.interval}
          <input type="number" inputMode="numeric" min={1} step={1} value={value.interval} onChange={(e) => set({ interval: e.target.value })} dir="ltr" className="input mt-1" />
        </label>
      )}
      {on === "week" && (
        <fieldset className="text-xs text-ink/70 sm:col-span-2">
          <legend>{R.weekdays}</legend>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink">
            {T.cal.weekdays.map((name, d) => (
              <label key={d} className="flex items-center gap-2">
                <input type="checkbox" name={`${id}-weekday`} checked={value.weekdays.includes(d)} onChange={(e) => set({ weekdays: e.target.checked ? [...value.weekdays, d] : value.weekdays.filter((x) => x !== d) })} />{name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {(on === "month" || on === "hmonth") && (
        <div className="text-xs text-ink/70 sm:col-span-2">
          <label className="block">{R.monthDay}
            <input type="number" inputMode="numeric" min={1} step={1} value={value.monthDay} disabled={value.last} onChange={(e) => set({ monthDay: e.target.value })} dir="ltr" className="input mt-1" />
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-ink"><input type="checkbox" name={`${id}-last`} checked={value.last} onChange={(e) => set({ last: e.target.checked })} />{R.lastDay}</label>
        </div>
      )}
      {on && (
        <>
          <label className="text-xs text-ink/70">{R.until}
            <input type="date" value={value.until} onChange={(e) => set({ until: e.target.value })} dir="ltr" className="input mt-1" />
          </label>
          <label className="text-xs text-ink/70">{R.count}
            <input type="number" inputMode="numeric" min={1} step={1} value={value.count} onChange={(e) => set({ count: e.target.value })} dir="ltr" className="input mt-1" />
          </label>
          <label className="text-xs text-ink/70 sm:col-span-2">{R.remindBefore}
            <input type="number" inputMode="numeric" min={0} step={1} value={value.remindBefore} onChange={(e) => set({ remindBefore: e.target.value })} dir="ltr" className="input mt-1" />
          </label>
          <p className="text-xs text-muted sm:col-span-2">{R.note}</p>
        </>
      )}
    </>
  );
}

/**
 * My to-dos. The list is rendered on the server; every action here is one PATCH or POST to /api/secretary and then a
 * refresh of the server render, so what the owner sees is always what is stored. Done needs a written result.
 */
/**
 * `canClose`: the owner or an admin (`todo.close`); a member adds, updates, snoozes and records follow-ups, and does not
 * see Done, Delete, Restore, Skip or Confirm / Not yet. `canWrite` (`todo.write`) gates Repeat and Stop repeat. Display
 * only: the route refuses the same actions (403).
 */
export default function TodoPanel({ t, zoneLabel, sections, approvals, snoozed, allClear, empty, done, deleted, tonight, canClose, canWrite, todoHref, timed, briefAt, lang, inboxHref, away, children }: {
  t: AppDict; zoneLabel: string; sections: TodoSection[]; approvals: { line: string; href: string } | null; snoozed: number; allClear: boolean; empty: boolean;
  done: TodoRow[]; deleted: TodoRow[]; tonight: boolean; canClose: boolean; canWrite: boolean; todoHref: string; timed: boolean; lang: "ar" | "en"; inboxHref: string;
  /** The morning brief's local time in the brand's zone ("08:00", "09:00"): when a reminder comes without timed reminders. */
  briefAt: string;
  /**
   * The away list (`AwayPanel`): its entries, the open items' contact names it suggests, whether this login may change
   * it (`todo.write`), and the brand's local days a last away day may fall between.
   */
  away: { entries: AwayRow[]; labels: string[]; canEdit: boolean; today: string; last: string };
  /** The Working days panel, rendered by the page after the done and deleted lists. */
  children?: React.ReactNode;
}) {
  const T = t.todo;
  const R = T.repeat;
  const timedText = timed ? T.timedOn : T.timedOff.replace("{brief}", () => briefAt);
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [result, setResult] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", dueAt: "", direction: "i_owe" as "i_owe" | "they_owe", party: "", remindAt: "", phone: "", repeat: EMPTY_RULE });
  const [rule, setRule] = useState<RuleForm>(EMPTY_RULE);
  const [phone, setPhone] = useState("");
  const [walk, setWalk] = useState<{ card: WalkCard | null; left: number } | null>(null);
  const [walkResult, setWalkResult] = useState<string | null>(null);
  // A row's "Away until…": the away panel opens again (a new key) with that contact's name in its form.
  const [awayFor, setAwayFor] = useState<{ label: string; n: number } | null>(null);

  // The Undo prompt is a toast pinned to the bottom of the screen, so a delete far down the page still shows it; it goes
  // away on its own after a few seconds.
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const errText = (code: unknown) => (typeof code === "string" && T.errors[code]) || T.errors.generic;
  async function send(id: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch(id === "new" ? "/api/secretary" : `/api/secretary/${id}`, { method: id === "new" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setError({ id, text: errText(j.error) });
        if (j.error === "conflict") router.refresh();
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError({ id, text: T.errors.generic });
      return false;
    } finally {
      setBusy(null);
    }
  }
  const open = (id: string, kind: NonNullable<Panel>["kind"], initial = "") => { setPanel(panel?.id === id && panel.kind === kind ? null : { id, kind }); setResult(""); setWhen(initial); setPhone(initial); setError(null); };
  async function act(row: TodoRow, body: Record<string, unknown>) {
    if (await send(row.id, { ...body, rev: row.rev })) setPanel(null);
  }
  const openRepeat = (row: TodoRow) => { open(row.id, "repeat"); setRule(ruleForm(row.repeatRule)); };
  async function remove(row: TodoRow) {
    if (await send(row.id, { action: "delete", rev: row.rev })) { setPanel(null); setUndo(row.id); }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { title: form.title, direction: form.direction, dueAt: form.dueAt || null };
    if (form.party.trim()) body[form.direction === "they_owe" ? "owedBy" : "owedTo"] = form.party;
    if (form.remindAt) body.remindAt = form.remindAt;
    if (form.direction === "they_owe" && form.phone.trim()) body.phone = form.phone;
    if (form.repeat.every) body.repeat = ruleBody(form.repeat);
    if (await send("new", body)) setForm({ title: "", dueAt: "", direction: form.direction, party: "", remindAt: "", phone: "", repeat: EMPTY_RULE });
  }
  // Tapping the WhatsApp link records the follow-up; the request outlives the tab switch (keepalive). Nothing is sent.
  function chasedByWhatsApp(row: TodoRow) {
    void fetch(`/api/secretary/${row.id}`, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "chased" }) }).then(() => router.refresh(), () => {});
  }

  // "Walk me through": one card at a time from the server; each button calls the item's own route, then the next card.
  async function walkLoad(next?: string) {
    setBusy("walk");
    setError(null);
    try {
      const r = await fetch(`/api/secretary/walk?lang=${lang}`, next ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "next", key: next }) } : undefined);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setError({ id: "walk", text: errText(j.error) }); return; }
      setWalk({ card: j.card ?? null, left: j.left ?? 0 });
      setWalkResult(null);
    } catch {
      setError({ id: "walk", text: T.errors.generic });
    } finally {
      setBusy(null);
    }
  }
  async function walkAct(card: WalkCard, action: WalkCard["actions"][number]) {
    if (action === "done" && walkResult === null) { setWalkResult(""); return; }
    if (action === "done" && !walkResult?.trim()) { setError({ id: "walk", text: T.errors.result_required }); return; }
    const body = action === "done" ? { action: "complete", result: walkResult } : action === "confirm" ? { action: "confirm_done" } : action === "not_yet" ? { action: "reject_done" } : action === "snooze" ? { action: "snooze", preset: "tomorrow" } : action === "chased" ? { action: "chased" } : { status: "approved", version: card.version };
    setBusy("walk");
    setError(null);
    try {
      const r = await fetch(card.kind === "approval" ? `/api/tasks/${card.id}` : `/api/secretary/${card.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      // Edited since this card was built: nothing was approved, and the walk reloads the card with the current draft.
      if (r.status === 409 && j.error === "changed") { await walkLoad(); setError({ id: "walk", text: lang === "ar" ? "تغيّرت هذه المسودة بعد عرض البطاقة، فلم تُعتمد. هذه نسختها الحالية." : "This draft changed after the card was shown, so it was not approved. Here is its current version." }); return; }
      if (!r.ok || j.ok === false) { setError({ id: "walk", text: errText(j.error) }); return; }
    } catch {
      setError({ id: "walk", text: T.errors.generic });
      return;
    } finally {
      setBusy(null);
    }
    router.refresh();
    await walkLoad();
  }
  const walkLabel = (a: WalkCard["actions"][number]) => ({ done: T.done, confirm: T.confirm, not_yet: T.notYet, snooze: T.snoozeTomorrow, chased: T.chased, approve: T.walk.approve, open: T.walk.open })[a];

  const item = (row: TodoRow, bucket: AgendaBucket | "done" | "deleted") => (
    <li key={row.id} className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium" dir="auto">{row.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className={bucket === "overdue" ? "font-semibold text-danger" : ""}>{row.due ?? T.noDue}</span>
            {row.who && <span dir="auto">{row.who}</span>}
            {row.repeat && <span className="badge badge-primary" dir="auto">{row.repeat}</span>}
            {row.badges.map((b) => <span key={b} className={`badge ${b === T.badges.critical ? "badge-danger" : "badge-primary"}`}>{b}</span>)}
          </p>
          {row.description && <p className="mt-1 whitespace-pre-line text-sm text-ink/70" dir="auto">{row.description}</p>}
          {row.chase && <p className="mt-1 text-xs text-muted" dir="auto">{row.chase}</p>}
          {row.remind && bucket !== "done" && bucket !== "deleted" && <p className="mt-1 text-xs text-ink" dir="auto">{row.remind}</p>}
          {row.proposed && (
            <div className="mt-1 space-y-1 text-sm">
              <p className="text-ink/80" dir="auto">{row.proposed.claim} <span className="text-xs text-muted">({T.claimNote})</span></p>
              <p className={row.fact ? "text-ink" : "text-muted"} dir="auto"><span className="font-semibold">{T.checked}</span> {row.fact || T.nothingChecked}</p>
            </div>
          )}
          {!row.proposed && row.fact && bucket === "done" && <p className="mt-1 text-xs text-ink" dir="auto"><span className="font-semibold">{T.checked}</span> {row.fact}</p>}
          {row.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted" aria-label={T.notes}>
              {row.notes.map((n, i) => <li key={i} dir="auto">{n}</li>)}
            </ul>
          )}
          {row.result && bucket === "done" && <p className="mt-1 text-sm text-ink/70" dir="auto"><span className="text-muted">{T.result}: </span>{row.result}</p>}
          {row.closedBy && bucket === "done" && <p className="mt-1 text-xs text-muted" dir="auto">{row.closedBy}</p>}
          {row.next && bucket !== "confirm" && <p className="mt-1 text-xs text-ink"><span className="text-muted">{T.next}: </span>{row.next}</p>}
        </div>
        {bucket === "confirm" ? (canClose && (
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => act(row, { action: "confirm_done" })} className="btn btn-primary btn-xs">{T.confirm}</button>
            <button disabled={!!busy} onClick={() => act(row, { action: "reject_done" })} className="btn btn-secondary btn-xs">{T.notYet}</button>
          </div>
        )) : bucket === "deleted" ? (canClose && (
          <button disabled={!!busy} onClick={async () => { if ((await send(row.id, { action: "restore" })) && undo === row.id) setUndo(null); }} className="btn btn-secondary btn-xs">{T.restore}</button>
        )) : bucket === "done" ? (canClose && (
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => send(row.id, { action: "reopen", rev: row.rev })} className="btn btn-secondary btn-xs">{T.reopen}</button>
            {row.seriesId && <Link href={`${todoHref}?series=${row.seriesId}`} className="btn btn-secondary btn-xs">{R.history}</Link>}
          </div>
        )) : (
          <div className="flex flex-wrap gap-2">
            {canClose && <button disabled={!!busy} onClick={() => open(row.id, "done")} aria-expanded={panel?.id === row.id && panel.kind === "done"} className="btn btn-primary btn-xs">{T.done}</button>}
            <button disabled={!!busy} onClick={() => open(row.id, "snooze")} aria-expanded={panel?.id === row.id && panel.kind === "snooze"} className="btn btn-secondary btn-xs">{T.snooze}</button>
            <button disabled={!!busy} onClick={() => open(row.id, "reschedule", row.dueLocal ?? "")} aria-expanded={panel?.id === row.id && panel.kind === "reschedule"} className="btn btn-secondary btn-xs">{T.reschedule}</button>
            <button disabled={!!busy} onClick={() => open(row.id, "remind", row.remindLocal ?? "")} aria-expanded={panel?.id === row.id && panel.kind === "remind"} className="btn btn-secondary btn-xs">{T.remind}</button>
            {row.theirs && <button disabled={!!busy} onClick={() => act(row, { action: "chased" })} title={T.chasedHint} className="btn btn-secondary btn-xs">{T.chased}</button>}
            {row.whatsapp && <a href={row.whatsapp} target="_blank" rel="noopener noreferrer" onClick={() => chasedByWhatsApp(row)} title={T.whatsappHint} className="btn btn-secondary btn-xs">{T.whatsapp}</a>}
            {row.theirs && <button disabled={!!busy} onClick={() => open(row.id, "phone", row.phone ?? "")} aria-expanded={panel?.id === row.id && panel.kind === "phone"} className="btn btn-secondary btn-xs">{T.phone}</button>}
            {row.contact && away.canEdit && <button onClick={() => setAwayFor({ label: row.contact!, n: (awayFor?.n ?? 0) + 1 })} className="btn btn-secondary btn-xs">{T.awayUntil}</button>}
            {canWrite && <button disabled={!!busy} onClick={() => openRepeat(row)} aria-expanded={panel?.id === row.id && panel.kind === "repeat"} className="btn btn-secondary btn-xs">{R.button}</button>}
            {row.repeat && canClose && <button disabled={!!busy} onClick={() => act(row, { action: "skip" })} className="btn btn-secondary btn-xs">{R.skip}</button>}
            {row.repeat && canWrite && <button disabled={!!busy} onClick={() => act(row, { action: "stop_repeat" })} className="btn btn-secondary btn-xs">{R.stop}</button>}
            {canClose && <button disabled={!!busy} onClick={() => remove(row)} className="btn btn-danger btn-xs">{T.remove}</button>}
          </div>
        )}
      </div>
      {row.reason && bucket !== "done" && bucket !== "deleted" && <p className="mt-2 text-xs text-danger" dir="auto">{row.reason}</p>}
      {panel?.id === row.id && panel.kind === "done" && (
        <form onSubmit={(e) => { e.preventDefault(); if (result.trim()) void act(row, { action: "complete", result }); else setError({ id: row.id, text: T.errors.result_required }); }} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-ink/70">{T.doneLabel}
            <input value={result} onChange={(e) => setResult(e.target.value)} placeholder={T.donePh} maxLength={1000} required dir="auto" className="input mt-1" autoFocus />
          </label>
          <button disabled={!!busy} className="btn btn-primary btn-sm">{T.doneSave}</button>
          <button type="button" onClick={() => setPanel(null)} className="btn btn-secondary btn-sm">{T.cancel}</button>
        </form>
      )}
      {panel?.id === row.id && panel.kind === "snooze" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={!!busy} onClick={() => act(row, { action: "snooze", preset: "2h" })} className="btn btn-secondary btn-xs">{T.snooze2h}</button>
          {tonight && <button disabled={!!busy} onClick={() => act(row, { action: "snooze", preset: "tonight" })} className="btn btn-secondary btn-xs">{T.snoozeTonight}</button>}
          <button disabled={!!busy} onClick={() => act(row, { action: "snooze", preset: "tomorrow" })} className="btn btn-secondary btn-xs">{T.snoozeTomorrow}</button>
          <button disabled={!!busy} onClick={() => act(row, { action: "snooze", preset: "nextweek" })} className="btn btn-secondary btn-xs">{T.snoozeNextWeek}</button>
        </div>
      )}
      {panel?.id === row.id && panel.kind === "remind" && (
        <form onSubmit={(e) => { e.preventDefault(); void act(row, { remindAt: when || null }); }} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-ink/70">{T.remindLabel.replace("{zone}", zoneLabel)}
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} dir="ltr" className="input mt-1" />
          </label>
          <button disabled={!!busy} className="btn btn-primary btn-sm">{T.save}</button>
          {row.remind && <button type="button" disabled={!!busy} onClick={() => act(row, { remindAt: null })} className="btn btn-secondary btn-sm">{T.remindClear}</button>}
          <button type="button" onClick={() => setPanel(null)} className="btn btn-secondary btn-sm">{T.cancel}</button>
          <p className="w-full text-xs text-muted">{timedText}</p>
        </form>
      )}
      {panel?.id === row.id && panel.kind === "phone" && (
        <form onSubmit={(e) => { e.preventDefault(); void act(row, { phone: phone.trim() || null }); }} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-ink/70">{T.phone}
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={T.add.phonePh} maxLength={40} dir="ltr" className="input mt-1" />
          </label>
          <button disabled={!!busy} className="btn btn-primary btn-sm">{T.save}</button>
          <button type="button" onClick={() => setPanel(null)} className="btn btn-secondary btn-sm">{T.cancel}</button>
        </form>
      )}
      {panel?.id === row.id && panel.kind === "reschedule" && (
        <form onSubmit={(e) => { e.preventDefault(); void act(row, { action: "reschedule", dueAt: when || null }); }} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-ink/70">{T.add.due.replace("{zone}", zoneLabel)}
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} dir="ltr" className="input mt-1" />
          </label>
          <button disabled={!!busy} className="btn btn-primary btn-sm">{T.save}</button>
          <button type="button" onClick={() => setPanel(null)} className="btn btn-secondary btn-sm">{T.cancel}</button>
          {row.repeat && <p className="w-full text-xs text-muted">{R.rescheduleNote}</p>}
        </form>
      )}
      {panel?.id === row.id && panel.kind === "repeat" && (
        <form onSubmit={(e) => { e.preventDefault(); void act(row, { repeat: ruleBody(rule) }); }} className="mt-3 grid gap-3 sm:grid-cols-2">
          <RepeatFields T={T} value={rule} onChange={setRule} none={false} id={`rule-${row.id}`} />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button disabled={!!busy} className="btn btn-primary btn-sm">{busy === row.id ? R.saving : R.save}</button>
            <button type="button" onClick={() => setPanel(null)} className="btn btn-secondary btn-sm">{T.cancel}</button>
          </div>
        </form>
      )}
      {error?.id === row.id && <p role="alert" className="mt-2 text-sm text-danger">{error.text}</p>}
    </li>
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="todopanel-t1" />{T.title}</span></h1>
      <p className="page-sub">{T.sub.replace("{zone}", zoneLabel)}</p>

      {approvals && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-lemon/40 bg-lemon/10 px-4 py-3 text-sm">
          <span>{approvals.line}</span>
          <Link href={approvals.href} className="btn btn-accent btn-xs">{T.openInbox}</Link>
        </div>
      )}
      <div className="mt-5">
        {!walk ? (
          <button disabled={!!busy} onClick={() => walkLoad()} className="btn btn-secondary btn-sm">{busy === "walk" ? T.walk.loading : T.walk.start}</button>
        ) : (
          <section aria-labelledby="todo-walk" className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="todo-walk" className="card-title">{T.walk.start}</h2>
              {walk.card && <span className="tnum text-xs text-muted">{T.walk.left.replace("{n}", String(walk.left))}</span>}
            </div>
            {walk.card ? (
              <div className="mt-3">
                <p className="font-medium" dir="auto">{walk.card.title}</p>
                <p className="mt-1 text-xs text-muted" dir="auto">{walk.card.line}</p>
                {walk.card.claim && (
                  <div className="mt-2 space-y-1 text-sm">
                    <p className="text-ink/80" dir="auto">{walk.card.claim.by}: «{walk.card.claim.text}» <span className="text-xs text-muted">({T.claimNote})</span></p>
                    <p className={walk.card.fact ? "text-ink" : "text-muted"} dir="auto"><span className="font-semibold">{T.checked}</span> {walk.card.fact || T.nothingChecked}</p>
                  </div>
                )}
                {walk.card.excerpt && <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-line rounded-lg bg-ink/5 px-3 py-2 text-sm text-ink/80" dir="auto">{walk.card.excerpt}</p>}
                {walk.card.held && <p className="mt-2 text-sm text-danger" dir="auto"><span className="font-semibold">{T.walk.held}</span> {walk.card.held}</p>}
                {walkResult !== null && (
                  <label className="mt-3 block text-xs text-ink/70">{T.doneLabel}
                    <input value={walkResult} onChange={(e) => setWalkResult(e.target.value)} placeholder={T.donePh} maxLength={1000} dir="auto" className="input mt-1" autoFocus />
                  </label>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {walk.card.actions.map((a) => a === "open"
                    ? <Link key={a} href={inboxHref} className="btn btn-secondary btn-xs">{walkLabel(a)}</Link>
                    : <button key={a} disabled={!!busy} onClick={() => walkAct(walk.card!, a)} className={`btn btn-xs ${a === "done" || a === "confirm" || a === "approve" ? "btn-primary" : "btn-secondary"}`}>{walkLabel(a)}</button>)}
                  <button disabled={!!busy} onClick={() => walkLoad(walk.card!.key)} className="btn btn-secondary btn-xs">{T.walk.next}</button>
                  <button onClick={() => { setWalk(null); setWalkResult(null); }} className="btn btn-secondary btn-xs">{T.walk.close}</button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
                <span>{T.walk.empty}</span>
                <button onClick={() => setWalk(null)} className="btn btn-secondary btn-xs">{T.walk.close}</button>
              </div>
            )}
            {error?.id === "walk" && <p role="alert" className="mt-2 text-sm text-danger">{error.text}</p>}
          </section>
        )}
      </div>
      {undo && (
        <div role="status" className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-md flex-wrap items-center justify-between gap-2 rounded-xl border-[1.5px] border-ink bg-white px-4 py-2 text-sm">
          <span>{T.removed}</span>
          <button onClick={async () => { const id = undo; setUndo(null); await send(id, { action: "restore" }); }} className="btn btn-secondary btn-xs">{T.undo}</button>
        </div>
      )}

      {empty ? <p className="mt-6 card text-sm text-muted">{T.empty}</p> : allClear && <p className="mt-6 text-sm text-muted">{T.allClear}</p>}
      {sections.map((s) => (
        <section key={s.bucket} className="mt-6" aria-labelledby={`todo-${s.bucket}`}>
          <h2 id={`todo-${s.bucket}`} className={`font-display text-lg font-semibold ${s.bucket === "overdue" ? "text-danger" : "text-ink"}`}>{s.title} <span className="tnum text-sm font-normal text-muted" dir="ltr">({s.rows.length})</span></h2>
          <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">{s.rows.map((r) => item(r, s.bucket))}</ul>
        </section>
      ))}
      {snoozed > 0 && <p className="mt-4 text-xs text-muted">{T.snoozed} <span className="tnum" dir="ltr">{snoozed}</span></p>}

      <form onSubmit={add} className="card mt-8">
        <h2 className="card-title">{T.add.title}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink/70 sm:col-span-2">{T.add.what}
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={T.add.whatPh} maxLength={200} required dir="auto" className="input mt-1" />
          </label>
          <label className="text-xs text-ink/70">{T.add.due.replace("{zone}", zoneLabel)}
            <input type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} dir="ltr" className="input mt-1" />
          </label>
          <fieldset className="text-xs text-ink/70">
            <legend>{T.add.direction}</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-ink">
              <label className="flex items-center gap-2"><input type="radio" name="direction" checked={form.direction === "i_owe"} onChange={() => setForm({ ...form, direction: "i_owe" })} />{T.add.iOwe}</label>
              <label className="flex items-center gap-2"><input type="radio" name="direction" checked={form.direction === "they_owe"} onChange={() => setForm({ ...form, direction: "they_owe" })} />{T.add.theyOwe}</label>
            </div>
          </fieldset>
          <label className="text-xs text-ink/70 sm:col-span-2">{form.direction === "they_owe" ? T.add.owedBy : T.add.owedTo}
            <input value={form.party} onChange={(e) => setForm({ ...form, party: e.target.value })} placeholder={T.add.owedByPh} maxLength={80} required={form.direction === "they_owe"} dir="auto" className="input mt-1" />
          </label>
          <label className="text-xs text-ink/70">{T.add.remind.replace("{zone}", zoneLabel)}
            <input type="datetime-local" value={form.remindAt} onChange={(e) => setForm({ ...form, remindAt: e.target.value })} dir="ltr" className="input mt-1" />
          </label>
          {form.direction === "they_owe" && (
            <label className="text-xs text-ink/70">{T.add.phone}
              <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={T.add.phonePh} maxLength={40} dir="ltr" className="input mt-1" />
            </label>
          )}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <RepeatFields T={T} value={form.repeat} onChange={(repeat) => setForm({ ...form, repeat })} none id="rule-new" />
        </div>
        <p className="mt-2 text-xs text-muted">{timedText}</p>
        {error?.id === "new" && <p role="alert" className="mt-2 text-sm text-danger">{error.text}</p>}
        <button disabled={!!busy || !form.title.trim()} className="btn btn-primary btn-sm mt-4">{busy === "new" ? T.add.saving : T.add.save}</button>
      </form>

      <AwayPanel key={awayFor?.n ?? 0} t={t} lang={lang} entries={away.entries} labels={away.labels} canEdit={away.canEdit} today={away.today} last={away.last} prefill={awayFor?.label} />

      {done.length > 0 && (
        <section className="mt-8" aria-labelledby="todo-done">
          <h2 id="todo-done" className="font-display text-lg font-semibold text-ink">{T.recentDone}</h2>
          <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">{done.map((r) => item(r, "done"))}</ul>
        </section>
      )}
      {deleted.length > 0 && (
        <section className="mt-8" aria-labelledby="todo-deleted">
          <h2 id="todo-deleted" className="font-display text-lg font-semibold text-ink/70">{T.deletedTitle}</h2>
          <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">{deleted.map((r) => item(r, "deleted"))}</ul>
        </section>
      )}
      {children}
      <p className="mt-6 text-xs text-muted">{T.note.replace("{brief}", () => briefAt)}</p>
    </div>
  );
}
