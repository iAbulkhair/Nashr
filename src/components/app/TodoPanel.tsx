"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { AgendaBucket } from "@/lib/secretary-agenda";

/** One item as the page shows it: every date already formatted on the server, in Riyadh time. */
export type TodoRow = {
  id: string; rev: number; title: string; description: string;
  due: string | null; dueLocal: string | null; who: string; next: string; badges: string[];
  proposed: { by: string; evidence: string } | null; result: string | null; notes: string[];
};
export type TodoSection = { bucket: AgendaBucket; title: string; rows: TodoRow[] };
type Panel = { id: string; kind: "done" | "snooze" | "reschedule" } | null;
const UNDO_MS = 8000;

/**
 * My to-dos. The list is rendered on the server; every action here is one PATCH or POST to /api/secretary and then a
 * refresh of the server render, so what the owner sees is always what is stored. Done needs a written result.
 */
export default function TodoPanel({ t, sections, approvals, snoozed, allClear, empty, done, deleted, tonight }: {
  t: AppDict; sections: TodoSection[]; approvals: { line: string; href: string } | null; snoozed: number; allClear: boolean; empty: boolean;
  done: TodoRow[]; deleted: TodoRow[]; tonight: boolean;
}) {
  const T = t.todo;
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [result, setResult] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", dueAt: "", direction: "i_owe" as "i_owe" | "they_owe", party: "" });

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
  const open = (id: string, kind: "done" | "snooze" | "reschedule", initial = "") => { setPanel(panel?.id === id && panel.kind === kind ? null : { id, kind }); setResult(""); setWhen(initial); setError(null); };
  async function act(row: TodoRow, body: Record<string, unknown>) {
    if (await send(row.id, { ...body, rev: row.rev })) setPanel(null);
  }
  async function remove(row: TodoRow) {
    if (await send(row.id, { action: "delete", rev: row.rev })) { setPanel(null); setUndo(row.id); }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { title: form.title, direction: form.direction, dueAt: form.dueAt || null };
    if (form.party.trim()) body[form.direction === "they_owe" ? "owedBy" : "owedTo"] = form.party;
    if (await send("new", body)) setForm({ title: "", dueAt: "", direction: form.direction, party: "" });
  }

  const item = (row: TodoRow, bucket: AgendaBucket | "done" | "deleted") => (
    <li key={row.id} className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium" dir="auto">{row.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink/60">
            <span className={bucket === "overdue" ? "font-semibold text-sadu" : ""}>{row.due ?? T.noDue}</span>
            {row.who && <span dir="auto">{row.who}</span>}
            {row.badges.map((b) => <span key={b} className={`badge ${b === T.badges.critical ? "badge-danger" : "badge-primary"}`}>{b}</span>)}
          </p>
          {row.description && <p className="mt-1 whitespace-pre-line text-sm text-ink/70" dir="auto">{row.description}</p>}
          {row.proposed && <p className="mt-1 text-sm text-ink/80" dir="auto">{T.proposedBy} <span className="font-semibold">{row.proposed.by}</span>: {row.proposed.evidence}</p>}
          {row.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-ink/60" aria-label={T.notes}>
              {row.notes.map((n, i) => <li key={i} dir="auto">{n}</li>)}
            </ul>
          )}
          {row.result && bucket === "done" && <p className="mt-1 text-sm text-ink/70" dir="auto"><span className="text-ink/50">{T.result}: </span>{row.result}</p>}
          {row.next && bucket !== "confirm" && <p className="mt-1 text-xs text-oasis"><span className="text-ink/50">{T.next}: </span>{row.next}</p>}
        </div>
        {bucket === "confirm" ? (
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => act(row, { action: "confirm_done" })} className="btn btn-primary btn-xs">{T.confirm}</button>
            <button disabled={!!busy} onClick={() => act(row, { action: "reject_done" })} className="btn btn-secondary btn-xs">{T.notYet}</button>
          </div>
        ) : bucket === "deleted" ? (
          <button disabled={!!busy} onClick={async () => { if ((await send(row.id, { action: "restore" })) && undo === row.id) setUndo(null); }} className="btn btn-secondary btn-xs">{T.restore}</button>
        ) : bucket === "done" ? null : (
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => open(row.id, "done")} aria-expanded={panel?.id === row.id && panel.kind === "done"} className="btn btn-primary btn-xs">{T.done}</button>
            <button disabled={!!busy} onClick={() => open(row.id, "snooze")} aria-expanded={panel?.id === row.id && panel.kind === "snooze"} className="btn btn-secondary btn-xs">{T.snooze}</button>
            <button disabled={!!busy} onClick={() => open(row.id, "reschedule", row.dueLocal ?? "")} aria-expanded={panel?.id === row.id && panel.kind === "reschedule"} className="btn btn-secondary btn-xs">{T.reschedule}</button>
            <button disabled={!!busy} onClick={() => remove(row)} className="btn btn-danger btn-xs">{T.remove}</button>
          </div>
        )}
      </div>
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
        </div>
      )}
      {panel?.id === row.id && panel.kind === "reschedule" && (
        <form onSubmit={(e) => { e.preventDefault(); void act(row, { action: "reschedule", dueAt: when || null }); }} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-ink/70">{T.add.due}
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} dir="ltr" className="input mt-1" />
          </label>
          <button disabled={!!busy} className="btn btn-primary btn-sm">{T.save}</button>
          <button type="button" onClick={() => setPanel(null)} className="btn btn-secondary btn-sm">{T.cancel}</button>
        </form>
      )}
      {error?.id === row.id && <p role="alert" className="mt-2 text-sm text-sadu">{error.text}</p>}
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{T.title}</h1>
      <p className="page-sub">{T.sub}</p>

      {approvals && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-saffron/40 bg-saffron/10 px-4 py-3 text-sm">
          <span>{approvals.line}</span>
          <Link href={approvals.href} className="btn btn-accent btn-xs">{T.openInbox}</Link>
        </div>
      )}
      {undo && (
        <div role="status" className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-md flex-wrap items-center justify-between gap-2 rounded-xl border border-ink/10 bg-white px-4 py-2 text-sm shadow-lg">
          <span>{T.removed}</span>
          <button onClick={async () => { const id = undo; setUndo(null); await send(id, { action: "restore" }); }} className="btn btn-secondary btn-xs">{T.undo}</button>
        </div>
      )}

      {empty ? <p className="mt-6 card text-sm text-ink/60">{T.empty}</p> : allClear && <p className="mt-6 text-sm text-ink/60">{T.allClear}</p>}
      {sections.map((s) => (
        <section key={s.bucket} className="mt-6" aria-labelledby={`todo-${s.bucket}`}>
          <h2 id={`todo-${s.bucket}`} className={`font-display text-lg font-semibold ${s.bucket === "overdue" ? "text-sadu" : "text-oasis"}`}>{s.title} <span className="tnum text-sm font-normal text-ink/50" dir="ltr">({s.rows.length})</span></h2>
          <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">{s.rows.map((r) => item(r, s.bucket))}</ul>
        </section>
      ))}
      {snoozed > 0 && <p className="mt-4 text-xs text-ink/50">{T.snoozed} <span className="tnum" dir="ltr">{snoozed}</span></p>}

      <form onSubmit={add} className="card mt-8">
        <h2 className="card-title">{T.add.title}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink/70 sm:col-span-2">{T.add.what}
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={T.add.whatPh} maxLength={200} required dir="auto" className="input mt-1" />
          </label>
          <label className="text-xs text-ink/70">{T.add.due}
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
        </div>
        {error?.id === "new" && <p role="alert" className="mt-2 text-sm text-sadu">{error.text}</p>}
        <button disabled={!!busy || !form.title.trim()} className="btn btn-primary btn-sm mt-4">{busy === "new" ? T.add.saving : T.add.save}</button>
      </form>

      {done.length > 0 && (
        <section className="mt-8" aria-labelledby="todo-done">
          <h2 id="todo-done" className="font-display text-lg font-semibold text-oasis">{T.recentDone}</h2>
          <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">{done.map((r) => item(r, "done"))}</ul>
        </section>
      )}
      {deleted.length > 0 && (
        <section className="mt-8" aria-labelledby="todo-deleted">
          <h2 id="todo-deleted" className="font-display text-lg font-semibold text-ink/70">{T.deletedTitle}</h2>
          <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">{deleted.map((r) => item(r, "deleted"))}</ul>
        </section>
      )}
      <p className="mt-6 text-xs text-ink/50">{T.note}</p>
    </div>
  );
}
