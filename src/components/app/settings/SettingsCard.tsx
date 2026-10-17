"use client";
import { useEffect, useId } from "react";
import Button from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

/**
 * May a settings card's Save be pressed (rule 1142)? Only when the value differs from what is stored, the value can be
 * saved as it stands, and no save of this card is already on its way.
 */
export const saveEnabled = ({ dirty, valid, busy }: { dirty: boolean; valid: boolean; busy: boolean }) => dirty && valid && !busy;

/** What a card's last save said: a success goes to the toast, an error stays under the card. */
export type CardStatus = { tone: "ok" | "error"; text: string } | null;

/**
 * Where a card's status is said (rule 2001): a finished save is news, so it is a toast and the card stays quiet; an error
 * is something to act on next to the field, so it stays under the card as an alert.
 */
export const statusTarget = (s: CardStatus): "toast" | "inline" | null => (!s || !s.text ? null : s.tone === "ok" ? "toast" : "inline");

/**
 * One setting, one card, one Save (rule 1142). The card is its own `<form>`, so Enter in its field saves it and nothing
 * else on the page. Save stays focusable while it cannot be pressed (`aria-disabled`, not `disabled`), so the keyboard
 * keeps its place after a save; the submit handler checks `saveEnabled` again before anything is sent. A card with no
 * `onSave` (a value shown read-only, or one this role may not change) has no Save at all.
 */
export default function SettingsCard({ title, sub, children, onSave, dirty = false, valid = true, busy = false, status = null, saveLabel, savingLabel, note, tone = "default" }: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
  onSave?: () => void | Promise<void>;
  dirty?: boolean;
  valid?: boolean;
  busy?: boolean;
  status?: CardStatus;
  saveLabel?: string;
  savingLabel?: string;
  /** A line in place of Save (why this person cannot change it). */
  note?: React.ReactNode;
  tone?: "default" | "danger";
}) {
  const id = useId();
  const toast = useToast();
  const enabled = saveEnabled({ dirty, valid, busy });
  // Each new status object is one save's answer: a success is said once, as a toast.
  useEffect(() => {
    if (statusTarget(status) === "toast") toast.success(status!.text);
  }, [status, toast]);
  const inline = statusTarget(status) === "inline";
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (onSave && enabled) void onSave();
  };
  const body = (
    <>
      <h2 id={`${id}-t`} className={`font-display text-lg font-bold ${tone === "danger" ? "text-danger" : "text-foreground"}`}>{title}</h2>
      {sub && <p className="mt-1 text-sm text-foreground-muted">{sub}</p>}
      {children && <div className="mt-4 grid gap-3">{children}</div>}
      {(onSave || note || inline) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {onSave && <Button type="submit" variant="primary" size="sm" loading={busy} loadingText={savingLabel} aria-disabled={!enabled || undefined}>{saveLabel}</Button>}
          {note && <p className="text-sm text-foreground-muted">{note}</p>}
          {inline && <p role="alert" className="text-sm text-danger">{status!.text}</p>}
        </div>
      )}
    </>
  );
  const cls = `card ${tone === "danger" ? "border-danger" : ""}`.trim();
  return onSave
    ? <form aria-labelledby={`${id}-t`} onSubmit={submit} noValidate className={cls}>{body}</form>
    : <section aria-labelledby={`${id}-t`} className={cls}>{body}</section>;
}
