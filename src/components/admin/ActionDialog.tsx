"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { emailMatches } from "../app/DeleteAccountDialog";
import type { Parsed } from "@/lib/admin-input";

const T = {
  en: { cancel: "Cancel", apply: "Apply" },
  ar: { cancel: "تراجع", apply: "تطبيق" },
} as const;

/** A form's values by field name; a checkbox is "1" when ticked and "" when not. */
export type FormValues = Record<string, string>;

export type FieldSpec = {
  name: string;
  label: string;
  /** "text" (the default) keeps what is typed as text, so the parser reads it exactly as the old prompt's answer. */
  kind?: "text" | "date" | "select" | "check" | "textarea";
  initial?: string;
  options?: readonly { value: string; label: string }[];
  /** Numbers, days, references and email addresses read left to right inside an Arabic page. */
  ltr?: boolean;
  maxLength?: number;
  /** Recomputed from the other values until the founder types in this field (a top-up's amount follows its pack). */
  follow?: (v: FormValues) => string;
  /** Type to confirm: the submit button stays off until this field is this email (case and outer spaces ignored). */
  mustMatch?: string;
};

/**
 * One founder change (rules 1100-1102): its fields, and `parse`, which turns the values into the request's body or an
 * error code. The body is always an object, so `null` means only "cancelled".
 */
export type ActionSpec<T extends object> = {
  title: string;
  /** The account the change is for, shown under the title, left to right. */
  subject?: string;
  message?: string;
  fields: FieldSpec[];
  submitLabel?: string;
  /** Deletes, removes, voids or refunds: the submit button is the solid danger one. */
  destructive?: boolean;
  parse: (v: FormValues) => Parsed<T>;
};

/**
 * The answer bookkeeping, kept apart from React so a test can drive it (as `confirmGate` in ConfirmDialog). One form is
 * open at a time: asking again while one is open answers the new one `null` at once and shows nothing, so a double click
 * on the button that asked can never send its change twice. `answer` settles the open form; any later answer before the
 * next form does nothing.
 */
export function formGate() {
  let waiting: ((v: object | null) => void) | null = null;
  let asked = 0;
  return {
    ask<T extends object>(show: (n: number) => void): Promise<T | null> {
      return new Promise<T | null>((resolve) => {
        if (waiting) { resolve(null); return; }
        waiting = resolve as (v: object | null) => void;
        asked += 1;
        show(asked);
      });
    },
    answer(v: object | null): void {
      const resolve = waiting;
      waiting = null;
      resolve?.(v);
    },
  };
}

/** Every field's first value: its own, else what it follows, else empty. */
export function initialValues(fields: readonly FieldSpec[]): FormValues {
  const v: FormValues = {};
  for (const f of fields) v[f.name] = f.initial ?? "";
  for (const f of fields) if (f.follow && f.initial === undefined) v[f.name] = f.follow(v);
  return v;
}

/** The form may be sent only when every type-to-confirm field holds its email. */
export const formReady = (fields: readonly FieldSpec[], v: FormValues) => fields.every((f) => !f.mustMatch || emailMatches(v[f.name] ?? "", f.mustMatch));

/**
 * The founder console's own form on a native `<dialog>` opened with `showModal()`, in place of the browser's prompt and
 * confirm (rule 1100): those could be blocked (an artifact frame, "prevent more dialogs"), chained up to six questions
 * for one change, and spoke the browser's language. The browser traps focus here, makes the page inert and closes the
 * dialog on Escape. Escape and Cancel answer `null`, so the change sends nothing; the submit button answers the parsed
 * body, once. A value the parser refuses shows its error in the form, which stays open with what was typed. A click
 * outside the box does nothing, so the second click of the double click that opened it cannot cancel it.
 */
function ActionDialog({ lang, spec, onAnswer }: { lang: "en" | "ar"; spec: ActionSpec<object>; onAnswer: (v: object | null) => void }) {
  const S = T[lang];
  const ref = useRef<HTMLDialogElement>(null);
  const answered = useRef(false);
  const touched = useRef(new Set<string>());
  const [values, setValues] = useState<FormValues>(() => initialValues(spec.fields));
  const [err, setErr] = useState("");
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  function answer(v: object | null) {
    if (answered.current) return;
    answered.current = true;
    if (ref.current?.open) ref.current.close();
    onAnswer(v);
  }
  function change(name: string, value: string) {
    touched.current.add(name);
    setErr("");
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      for (const f of spec.fields) if (f.follow && !touched.current.has(f.name)) next[f.name] = f.follow(next);
      return next;
    });
  }
  const ready = formReady(spec.fields, values);
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || answered.current) return;
    const p = spec.parse(values);
    if (!p.ok) { setErr(p.error); return; }
    answer(p.value);
  }
  const input = "mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm";
  return (
    <dialog ref={ref} role={spec.destructive ? "alertdialog" : "dialog"} aria-labelledby={`${id}-title`} aria-describedby={spec.message ? `${id}-message` : undefined} onClose={() => answer(null)} className="card m-auto w-[calc(100%-2rem)] max-w-lg p-0 text-ink backdrop:bg-ink/40">
      <form onSubmit={submit} className="grid gap-4 p-6 text-start" data-testid="action-dialog">
        <div>
          <h2 id={`${id}-title`} className="font-display text-lg font-bold">{spec.title}</h2>
          {spec.subject && <p className="mt-1 text-sm text-muted" dir="ltr">{spec.subject}</p>}
          {spec.message && <p id={`${id}-message`} className="mt-2 text-sm leading-relaxed text-ink/80">{spec.message}</p>}
        </div>
        {spec.fields.map((f) => {
          const fid = `${id}-${f.name}`;
          const dir = f.ltr ? "ltr" : "auto";
          const v = values[f.name] ?? "";
          if (f.kind === "check") return (
            <label key={f.name} className="flex items-start gap-2 text-sm">
              <input id={fid} name={f.name} type="checkbox" checked={v === "1"} onChange={(e) => change(f.name, e.target.checked ? "1" : "")} className="mt-1" />
              <span>{f.label}</span>
            </label>
          );
          return (
            <div key={f.name}>
              <label htmlFor={fid} className="text-sm font-medium">{f.label}{f.mustMatch && <> <bdi className="font-mono text-xs text-muted" dir="ltr">{f.mustMatch}</bdi></>}</label>
              {f.kind === "select" ? (
                <select id={fid} name={f.name} value={v} dir={dir} onChange={(e) => change(f.name, e.target.value)} className={input}>
                  {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.kind === "textarea" ? (
                <textarea id={fid} name={f.name} value={v} dir={dir} rows={2} maxLength={f.maxLength} onChange={(e) => change(f.name, e.target.value)} className={input} />
              ) : (
                <input id={fid} name={f.name} type={f.kind === "date" ? "date" : "text"} value={v} dir={dir} maxLength={f.maxLength} autoComplete="off" onChange={(e) => change(f.name, e.target.value)} className={input} />
              )}
            </div>
          );
        })}
        {err && <p role="alert" className="text-sm text-danger" dir="ltr">{err}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={() => answer(null)} className="btn btn-secondary btn-sm">{S.cancel}</button>
          {/* A click the browser counts as the second of a double click began on the page behind, not in this form. */}
          <button type="submit" disabled={!ready} onClick={(e) => { if (e.detail > 1) e.preventDefault(); }} className={`btn btn-sm ${spec.destructive ? "btn-danger-solid" : "btn-primary"}`}>{spec.submitLabel ?? S.apply}</button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * `const [ask, actionDialog] = useActionDialog(lang)`: render `actionDialog` once, then
 * `const v = await ask({...}); if (!v) return;` before the change's request. A form still open when the section unmounts
 * is never answered, so its change is never sent.
 */
export function useActionDialog(lang: "en" | "ar"): [<T extends object>(spec: ActionSpec<T>) => Promise<T | null>, React.ReactNode] {
  const [gate] = useState(formGate);
  const [open, setOpen] = useState<{ spec: ActionSpec<object>; n: number } | null>(null);
  const ask = useCallback(<T extends object>(spec: ActionSpec<T>) => gate.ask<T>((n) => setOpen({ spec: spec as ActionSpec<object>, n })), [gate]);
  const answer = useCallback((v: object | null) => {
    setOpen(null);
    gate.answer(v);
  }, [gate]);
  const dialog = open ? <ActionDialog key={open.n} lang={lang} spec={open.spec} onAnswer={answer} /> : null;
  return [ask, dialog];
}
