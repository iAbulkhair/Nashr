"use client";
import { useCallback, useRef, useState } from "react";
import { FormDialog } from "@/components/ui/Dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { emailMatches } from "../app/DeleteAccountDialog";
import { REASON_MAX, inputError, parseReason, type Parsed } from "@/lib/admin-input";

/** The form's own words; every field label comes from the section's dictionary. */
export const FORM_COPY = {
  en: { cancel: "Cancel", apply: "Apply", busy: "Saving…", reason: "Reason", reasonHint: "Kept in the audit log with the change, 3 to 200 characters.", confirmAs: "Type to confirm" },
  ar: { cancel: "تراجع", apply: "تطبيق", busy: "جارٍ الحفظ…", reason: "السبب", reasonHint: "يُحفظ في سجل التدقيق مع التغيير، من 3 إلى 200 حرف.", confirmAs: "اكتب للتأكيد" },
} as const;

/** A form's values by field name; a checkbox is "1" when ticked and "" when not. */
export type FormValues = Record<string, string>;

export type FieldSpec = {
  name: string;
  label: string;
  /** "text" (the default) keeps what is typed as text, so the parser reads it exactly as typed. */
  kind?: "text" | "date" | "select" | "check" | "textarea";
  initial?: string;
  options?: readonly { value: string; label: string }[];
  /** Numbers, days, references and email addresses read left to right inside an Arabic page. */
  ltr?: boolean;
  maxLength?: number;
  hint?: string;
  /** Recomputed from the other values until the founder types in this field (a top-up's amount follows its pack). */
  follow?: (v: FormValues) => string;
  /** Type to confirm: the submit stays `aria-disabled` until this field is this email (case and outer spaces ignored). */
  mustMatch?: string;
};

/**
 * One founder change (rules 1100-1102, 1176): its fields and `parse`, which turns the values into the request's body or
 * an error code. A reason field is added last unless `reason: false` (only for a read that changes nothing). The body
 * is always an object, so `null` means only "cancelled".
 */
export type ActionSpec<T extends object> = {
  title: string;
  /** The account the change is for, shown under the title, left to right. */
  subject?: string;
  message?: string;
  fields: FieldSpec[];
  submitLabel?: string;
  /** Deletes, removes, voids, refunds or impersonates: the solid danger button and `role="alertdialog"`. */
  destructive?: boolean;
  reason?: boolean;
  /** An example shown in the empty reason box; it is never sent. */
  reasonPlaceholder?: string;
  parse: (v: FormValues) => Parsed<T>;
};

/**
 * The answer bookkeeping, kept apart from React so a test can drive it (from #321's `formGate`). One form is open at a
 * time: asking again while one is open answers the new one `null` at once and shows nothing, so a double click on the
 * button that asked can never send its change twice. `answer` settles the open form; any later answer does nothing.
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
 * What a submit answers: the parsed body with the reason, or the error code. The reason is checked first, so an empty
 * one is refused before any other field (rule 1176).
 */
export function submitForm<T extends object>(spec: ActionSpec<T>, v: FormValues): Parsed<T & { reason?: string }> {
  if (!formReady(spec.fields, v)) return { ok: false, error: "mismatch" };
  let reason: string | undefined;
  if (spec.reason !== false) {
    const r = parseReason(v.reason);
    if (!r.ok) return r;
    reason = r.value;
  }
  const p = spec.parse(v);
  if (!p.ok) return p;
  return { ok: true, value: reason === undefined ? p.value : { ...p.value, reason } };
}

/**
 * The founder console's one form (rule 1176), on Phase 1's `FormDialog` (a native `<dialog>` opened with `showModal()`:
 * focus is trapped inside, the page is inert, Escape closes it, focus goes back to the button that opened it). Escape
 * and Cancel answer `null`, so the change sends nothing; the submit answers the parsed body once. A value the parser
 * refuses shows its words inside the form, which stays open with what was typed.
 */
function AdminFormDialog({ lang, spec, onAnswer }: { lang: "en" | "ar"; spec: ActionSpec<object>; onAnswer: (v: object | null) => void }) {
  const C = FORM_COPY[lang];
  const answered = useRef(false);
  const touched = useRef(new Set<string>());
  const [values, setValues] = useState<FormValues>(() => initialValues(spec.fields));
  function answer(v: object | null) {
    if (answered.current) return;
    answered.current = true;
    onAnswer(v);
  }
  function change(name: string, value: string) {
    touched.current.add(name);
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      for (const f of spec.fields) if (f.follow && !touched.current.has(f.name)) next[f.name] = f.follow(next);
      return next;
    });
  }
  const ready = formReady(spec.fields, values);
  return (
    <FormDialog
      lang={lang}
      title={spec.title}
      description={spec.subject || spec.message ? <>{spec.subject && <bdi className="block font-mono text-xs text-foreground-muted" dir="ltr">{spec.subject}</bdi>}{spec.message && <span className="mt-1 block">{spec.message}</span>}</> : undefined}
      submitLabel={spec.submitLabel ?? C.apply}
      cancelLabel={C.cancel}
      busyLabel={C.busy}
      destructive={spec.destructive}
      role={spec.destructive ? "alertdialog" : "dialog"}
      submitReady={ready}
      className="max-w-lg"
      onSubmit={async () => {
        const p = submitForm(spec, values);
        if (!p.ok) return inputError(lang, p.error);
        answer(p.value);
      }}
      onClose={() => answer(null)}
    >
      {spec.fields.map((f) => {
        const v = values[f.name] ?? "";
        const dir = f.ltr ? "ltr" : "auto";
        if (f.kind === "check") return (
          <label key={f.name} className="flex min-h-[var(--hit-min)] items-center gap-3 text-sm">
            <input name={f.name} type="checkbox" checked={v === "1"} onChange={(e) => change(f.name, e.target.checked ? "1" : "")} className="h-5 w-5" />
            <span>{f.label}</span>
          </label>
        );
        const label = f.mustMatch ? <>{f.label} <bdi className="font-mono text-xs text-foreground-muted" dir="ltr">{f.mustMatch}</bdi></> : f.label;
        return (
          <Field key={f.name} label={label} hint={f.hint}>
            {f.kind === "select" ? (
              <Select name={f.name} value={v} dir={dir} onChange={(e) => change(f.name, e.target.value)}>
                {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            ) : f.kind === "textarea" ? (
              <Textarea name={f.name} value={v} dir={dir} rows={2} maxLength={f.maxLength} onChange={(e) => change(f.name, e.target.value)} />
            ) : (
              <Input name={f.name} type={f.kind === "date" ? "date" : "text"} value={v} dir={dir} maxLength={f.maxLength} autoComplete="off" onChange={(e) => change(f.name, e.target.value)} />
            )}
          </Field>
        );
      })}
      {spec.reason !== false && (
        <Field label={C.reason} hint={C.reasonHint}>
          <Textarea name="reason" value={values.reason ?? ""} rows={2} maxLength={REASON_MAX} placeholder={spec.reasonPlaceholder} onChange={(e) => change("reason", e.target.value)} />
        </Field>
      )}
    </FormDialog>
  );
}

/**
 * `const [ask, formDialog] = useAdminForm(lang)`: render `formDialog` once, then `const v = await ask({...}); if (!v)
 * return;` before the change's request. A form still open when the section unmounts is never answered, so its change
 * is never sent.
 */
export function useAdminForm(lang: "en" | "ar"): [<T extends object>(spec: ActionSpec<T>) => Promise<(T & { reason?: string }) | null>, React.ReactNode] {
  const [gate] = useState(formGate);
  const [open, setOpen] = useState<{ spec: ActionSpec<object>; n: number } | null>(null);
  const ask = useCallback(<T extends object>(spec: ActionSpec<T>) => gate.ask<T & { reason?: string }>((n) => setOpen({ spec: spec as ActionSpec<object>, n })), [gate]);
  const answer = useCallback((v: object | null) => {
    setOpen(null);
    gate.answer(v);
  }, [gate]);
  const dialog = open ? <AdminFormDialog key={open.n} lang={lang} spec={open.spec} onAnswer={answer} /> : null;
  return [ask, dialog];
}
