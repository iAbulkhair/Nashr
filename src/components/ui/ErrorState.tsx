"use client";
import { useState } from "react";
import Button from "./Button";

/**
 * Something did not load (rule 1116): an alert that says so in words, and a Try again that runs `onRetry` with the
 * button busy until it settles. Used where a screen used to wait forever on a failed read (B-12: the profile's "…").
 */
export default function ErrorState({ title, body, retryLabel, onRetry, className = "" }: {
  title: React.ReactNode;
  body?: React.ReactNode;
  retryLabel: string;
  onRetry?: () => Promise<unknown> | void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function retry() {
    if (!onRetry || busy) return;
    setBusy(true);
    try { await onRetry(); } finally { setBusy(false); }
  }
  return (
    <div role="alert" className={`callout callout-danger ${className}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="callout-icon" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4.5M12 16h.01" /></svg>
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="callout-title">{title}</p>
        {body && <p>{body}</p>}
        {onRetry && <div className="mt-1"><Button variant="secondary" size="sm" loading={busy} onClick={retry}>{retryLabel}</Button></div>}
      </div>
    </div>
  );
}
