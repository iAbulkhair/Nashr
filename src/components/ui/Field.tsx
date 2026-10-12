"use client";
import { createContext, useContext, useId } from "react";

/** What a `Field` hands to the control inside it. */
type FieldCtx = { id: string; describedBy?: string; invalid: boolean; required: boolean };

const Ctx = createContext<FieldCtx | null>(null);

/** Joins id lists for `aria-describedby`, dropping the empty ones; undefined when nothing is left. */
export function joinIds(...ids: (string | undefined | null | false)[]): string | undefined {
  const s = ids.filter(Boolean).join(" ").trim();
  return s || undefined;
}

/**
 * The control's own props merged with its `Field`'s (rule 1084): the field's id unless the caller set one, the hint and
 * error ids added to any `aria-describedby` the caller passed (a password's rules list keeps its place), `aria-invalid`
 * while the field shows an error, and `required` when the field is. Outside a `Field` the props pass through unchanged,
 * so `PasswordField` and the controls below work on their own too.
 */
export function useFieldProps<P extends { id?: string; required?: boolean; "aria-describedby"?: string; "aria-invalid"?: React.AriaAttributes["aria-invalid"] }>(props: P): P {
  const f = useContext(Ctx);
  if (!f) return props;
  return {
    ...props,
    id: props.id ?? f.id,
    required: props.required ?? (f.required || undefined),
    "aria-describedby": joinIds(props["aria-describedby"], f.describedBy),
    "aria-invalid": props["aria-invalid"] ?? (f.invalid || undefined),
  };
}

type FieldProps = {
  /** The visible label. Every field has one; a placeholder is an example, never the label. */
  label: React.ReactNode;
  /** Help under the control, read with it by screen readers. */
  hint?: React.ReactNode;
  /** The field's own error, shown under it and announced; the control is marked invalid while it shows. */
  error?: React.ReactNode;
  required?: boolean;
  /** "optional" / «اختياري», from the caller's dictionary, shown after the label. */
  optionalText?: string;
  /** Keeps the label for screen readers only, where the context already names the field (one-line add forms). */
  hideLabel?: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
};

/**
 * Label, control, hint and error as one unit (rule 1084). The control is the child: `Input`, `Textarea`, `Select` or
 * `PasswordField` read the ids from context, so no form wires `htmlFor`, `aria-describedby` or `aria-invalid` by hand.
 */
export function Field({ label, hint, error, required = false, optionalText, hideLabel = false, id, className = "", children }: FieldProps) {
  const auto = useId();
  const fid = id ?? `f${auto.replace(/[^\w-]/g, "")}`;
  const hintId = hint ? `${fid}-hint` : undefined;
  const errId = error ? `${fid}-error` : undefined;
  return (
    <div className={`grid gap-1.5 text-start ${className}`}>
      <label htmlFor={fid} className={hideLabel ? "sr-only" : "field-label"}>
        {label}
        {optionalText && !required && <span className="ms-1.5 text-xs font-normal text-foreground-muted">({optionalText})</span>}
      </label>
      <Ctx.Provider value={{ id: fid, describedBy: joinIds(hintId, errId), invalid: Boolean(error), required }}>{children}</Ctx.Provider>
      {hint && <p id={hintId} className="field-hint">{hint}</p>}
      {error && <p id={errId} role="alert" className="field-error">{error}</p>}
    </div>
  );
}

/**
 * Text input. Free text gets `dir="auto"`, so an English brand name on an Arabic page reads in its own direction; an
 * email, URL, phone or number stays left to right. The caller's `dir` wins.
 */
export function Input({ className = "", type = "text", dir, ...props }: React.ComponentProps<"input">) {
  const p = useFieldProps(props);
  const ltr = ["email", "url", "tel", "number", "password"].includes(type);
  return <input {...p} type={type} dir={dir ?? (ltr ? "ltr" : "auto")} className={`input control ${className}`.trim()} />;
}

export function Textarea({ className = "", dir = "auto", ...props }: React.ComponentProps<"textarea">) {
  const p = useFieldProps(props);
  return <textarea {...p} dir={dir} className={`input control ${className}`.trim()} />;
}

export function Select({ className = "", ...props }: React.ComponentProps<"select">) {
  const p = useFieldProps(props);
  return <select {...p} className={`input control ${className}`.trim()} />;
}
