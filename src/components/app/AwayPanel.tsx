"use client";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { AwayEntry } from "@/lib/secretary-away";
import { fill } from "@/lib/fill";
import { localDay, useOneWrite } from "./useOneWrite";

/** One contact on the away list as GET /api/secretary/away gives it: `ended` once the last away day is before today. */
export type AwayRow = AwayEntry & { ended: boolean };

/**
 * The request a list action sends to /api/secretary/away (ruling R21): "End now" ends a running absence, idempotently, so
 * a second click changes nothing and the "back" alert still follows; "Remove" deletes an entry, to free the 200-name cap.
 */
export function awayCall(action: "end" | "remove", label: string): { method: "DELETE"; body: { label: string; remove?: true } } {
  return { method: "DELETE", body: action === "remove" ? { label, remove: true } : { label } };
}

/**
 * «الغائبون» / "Away" on My to-dos (spec §3.2): the brand's away list, each running absence with "End now" and each ended
 * one with "Remove", and a form that marks a contact away until a last day (PUT /api/secretary/away). The name field
 * suggests the contacts of the open items already on the page (`labels`); a row's "Away until…" remounts this panel with
 * the name filled in (`prefill`) and moves to the form. `today` and `last` are the brand's local days the last away day
 * may fall between. Every write needs `todo.write` (`canEdit`, every member: the route refuses the same), runs one at a
 * time (`useOneWrite`: a second click while one is in flight sends nothing), then refreshes the server render, so the
 * list and the to-dos it holds back show what is stored.
 */
export default function AwayPanel({ t, lang, entries, labels, canEdit, today, last, prefill }: {
  t: AppDict; lang: "ar" | "en"; entries: AwayRow[]; labels: string[]; canEdit: boolean; today: string; last: string; prefill?: string;
}) {
  const T = t.todo.away;
  const [form, setForm] = useState({ label: prefill ?? "", until: "", note: "" });
  const { busy, error, send } = useOneWrite(t, { not_found: T.notFound });
  const formRef = useRef<HTMLFormElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  // Opened from a row's "Away until…": bring the form into view, the cursor on the last away day.
  useEffect(() => {
    if (!prefill) return;
    formRef.current?.scrollIntoView({ block: "center" });
    dateRef.current?.focus({ preventScroll: true });
  }, [prefill]);

  const day = localDay(lang, today);
  const write = (key: string, call: { method: "PUT" | "DELETE"; body: Record<string, unknown> }) => send(key, "/api/secretary/away", call.method, call.body);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { label: form.label, until: form.until };
    if (form.note.trim()) body.note = form.note;
    if (await write("save", { method: "PUT", body })) setForm({ label: "", until: "", note: "" });
  }

  return (
    <section id="todo-away" aria-labelledby="todo-away-title" className="card mt-8">
      <h2 id="todo-away-title" className="card-title">{T.title}</h2>
      <p className="mt-1 text-sm text-ink/60">{T.sub}</p>
      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-ink/60">{T.empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink/10 rounded-xl border border-ink/10">
          {entries.map((e) => (
            <li key={e.label} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium" dir="auto">{e.label}</p>
                <p className={`mt-0.5 text-xs ${e.ended ? "text-ink/50" : "text-oasis"}`} suppressHydrationWarning>{fill(e.ended ? T.ended : T.until, { date: day(e.until) })}</p>
                {e.note && <p className="mt-0.5 break-words text-xs text-ink/60" dir="auto">{e.note}</p>}
              </div>
              {canEdit && (e.ended ? (
                <button disabled={!!busy} onClick={() => write(`remove:${e.label}`, awayCall("remove", e.label))} className="btn btn-secondary btn-xs">{T.removeEntry}</button>
              ) : (
                <button disabled={!!busy} onClick={() => write(`end:${e.label}`, awayCall("end", e.label))} className="btn btn-secondary btn-xs">{T.endNow}</button>
              ))}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form ref={formRef} onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
          <h3 className="text-sm font-semibold sm:col-span-2">{T.add}</h3>
          <label className="min-w-0 text-xs text-ink/70">{T.name}
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} list="todo-away-labels" placeholder={T.namePh} maxLength={80} required dir="auto" className="input mt-1" />
          </label>
          <datalist id="todo-away-labels">{labels.map((l) => <option key={l} value={l} />)}</datalist>
          <label className="min-w-0 text-xs text-ink/70">{T.lastDay}
            <input ref={dateRef} type="date" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} min={today} max={last} required dir="ltr" className="input mt-1" />
          </label>
          <label className="min-w-0 text-xs text-ink/70 sm:col-span-2">{T.note}
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={200} dir="auto" className="input mt-1" />
          </label>
          <div className="sm:col-span-2">
            <button disabled={!!busy || !form.label.trim() || !form.until} className="btn btn-primary btn-sm">{busy === "save" ? T.saving : T.save}</button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-sadu">{error.text}</p>}
    </section>
  );
}
