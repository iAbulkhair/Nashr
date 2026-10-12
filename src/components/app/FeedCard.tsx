"use client";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { fill } from "@/lib/fill";
import { formatWhen } from "@/lib/secretary-agenda";
import { refusalText, useOneWrite } from "./useOneWrite";

/**
 * What the card shows. `created` holds the link: it is component state only (never stored, never in the URL, never
 * logged), so it is gone when the page is left; after that the card is `exists`, with the date (`since`, already written in
 * the page's language) and Renew and Stop.
 */
export type FeedState =
  | { kind: "loading" }
  | { kind: "failed"; text?: string }
  | { kind: "none" }
  | { kind: "created"; url: string; webcal: string }
  | { kind: "exists"; since: string; sameBrand?: boolean };

type Copied = "url" | "webcal" | null;

/**
 * The card's markup for one state (no fetching, so a test can render each state). `busy` names the running write
 * (`create`, `renew` or `stop`), `confirming` shows the inline "Stop?" question, `copied` which Copy button was pressed.
 */
export function FeedView({ t, state, busy = null, error = null, confirming = false, copied = null, onCreate, onStop, onConfirmStop, onCancel, onCopy, onRetry }: {
  t: AppDict; state: FeedState; busy?: string | null; error?: string | null; confirming?: boolean; copied?: Copied;
  onCreate?: (key: "create" | "renew") => void; onStop?: () => void; onConfirmStop?: (on: boolean) => void; onCancel?: () => void; onCopy?: (which: "url" | "webcal", text: string) => void; onRetry?: () => void;
}) {
  const T = t.todo.feed;
  const off = !!busy;
  const copyRow = (which: "url" | "webcal", label: string, text: string) => (
    <div>
      <p className="text-xs text-foreground-muted">{label}</p>
      <div className="mt-1 flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 basis-56 break-all rounded bg-background-muted px-3 py-2 text-xs" dir="ltr">{text}</code>
        <button type="button" onClick={() => onCopy?.(which, text)} aria-label={`${T.copy}: ${label}`} className="btn btn-secondary btn-xs">{copied === which ? T.copied : T.copy}</button>
        <span role="status" aria-live="polite" className="sr-only">{copied === which ? T.copied : ""}</span>
      </div>
    </div>
  );
  return (
    <section id="todo-feed" aria-labelledby="todo-feed-title" className="card mt-8">
      <h2 id="todo-feed-title" className="card-title">{T.title}</h2>
      <p className="mt-1 text-sm text-foreground-muted">{T.sub}</p>
      {state.kind === "loading" && <p className="mt-3 text-sm text-foreground-muted">{T.loading}</p>}
      {state.kind === "failed" && (
        <div className="mt-3">
          <p role="alert" className="text-sm text-danger">{state.text ?? T.error}</p>
          <button type="button" onClick={() => onRetry?.()} className="btn btn-secondary btn-sm mt-2">{t.handoff.retry}</button>
        </div>
      )}
      {state.kind === "none" && (
        <div className="mt-3">
          <button type="button" disabled={off} onClick={() => onCreate?.("create")} className="btn btn-primary btn-sm">{busy === "create" ? T.creating : T.create}</button>
        </div>
      )}
      {state.kind === "created" && (
        <div className="mt-3 grid gap-3">
          {copyRow("url", T.link, state.url)}
          {copyRow("webcal", T.webcal, state.webcal)}
          <p className="text-xs text-foreground-muted">{T.shownOnce}</p>
          <p className="rounded-xl border border-foreground/10 px-3 py-2 text-sm">{T.warning}</p>
          <ul className="grid gap-1 text-sm text-foreground-muted">
            <li>{T.iphone}</li>
            <li>{T.google}</li>
            <li>{T.outlook}</li>
          </ul>
        </div>
      )}
      {state.kind === "exists" && (
        <div className="mt-3 grid gap-1 text-sm">
          <p>{fill(T.since, { date: state.since })}</p>
          {state.sameBrand === false && <p className="text-foreground-muted">{T.otherBrand}</p>}
        </div>
      )}
      {(state.kind === "created" || state.kind === "exists") && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <p className="w-full text-sm" role="alert">{T.confirmStop}</p>
              <button type="button" disabled={off} onClick={() => onStop?.()} className="btn btn-primary btn-sm">{busy === "stop" ? T.stopping : T.confirmYes}</button>
              <button type="button" disabled={off} onClick={() => onCancel?.()} className="btn btn-secondary btn-sm">{T.cancel}</button>
            </>
          ) : (
            <>
              <button type="button" disabled={off} onClick={() => onCreate?.("renew")} className="btn btn-secondary btn-sm">{busy === "renew" ? T.renewing : T.renew}</button>
              <button type="button" disabled={off} onClick={() => onConfirmStop?.(true)} className="btn btn-secondary btn-sm">{T.stop}</button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

/**
 * «اشترك من تقويمك» / "Subscribe from your calendar" on My to-dos (Reem phase 3 B1, spec section 8): the owner's private
 * calendar feed link. Every role may make one (`feed.manage`). The status comes from GET /api/secretary/feed (whether a
 * link exists and since when, never the link). Create and Renew POST the page's language and get the link once; Stop
 * deletes it after an inline confirm. Writes run one at a time (`useOneWrite`). The link stays in this component's state:
 * not in local storage, not in the URL, not in the console, and it is dropped as soon as the page is left.
 */
export default function FeedCard({ t, lang }: { t: AppDict; lang: "ar" | "en" }) {
  const T = t.todo.feed;
  const [state, setState] = useState<FeedState>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<Copied>(null);
  const words = { busy: T.busy, forbidden: T.error };
  const { busy, error, send } = useOneWrite(t, words);
  // Bumped by "Try again": the status read runs again.
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/secretary/feed", { cache: "no-store" })
      .then(async (r) => ({ status: r.status, ok: r.ok, j: (await r.json().catch(() => ({}))) as { ok?: boolean; error?: unknown; exists?: boolean; createdAt?: string | null; sameBrand?: boolean } }))
      .then(({ status, ok, j }) => {
        if (!live) return;
        // A refusal (too many requests, no access) says so in the page's words, as a refused write does.
        if (!ok || !j.ok) return setState({ kind: "failed", text: refusalText(t, status, j.error, words) });
        setState(j.exists && j.createdAt ? { kind: "exists", since: formatWhen(j.createdAt, true, lang, Date.now()), sameBrand: j.sameBrand !== false } : { kind: "none" });
      })
      .catch(() => live && setState({ kind: "failed" }));
    return () => { live = false; };
    // `t`, `words` and `lang` do not change while the page is open: the read runs on mount and on "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // The "Copied" label goes after a moment; a pending timeout is cleared when the card goes away.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function retry() {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }

  async function create(key: "create" | "renew") {
    const j = await send(key, "/api/secretary/feed", "POST", { lang });
    if (j && typeof j.url === "string" && typeof j.webcal === "string") {
      setConfirming(false);
      setCopied(null);
      setState({ kind: "created", url: j.url, webcal: j.webcal });
    }
  }
  async function stop() {
    if (await send("stop", "/api/secretary/feed", "DELETE")) {
      setConfirming(false);
      setCopied(null);
      setState({ kind: "none" });
    }
  }
  async function copy(which: "url" | "webcal", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      // The link stays on screen to copy by hand.
    }
  }

  return <FeedView t={t} state={state} busy={busy} error={error?.text ?? null} confirming={confirming} copied={copied} onCreate={create} onStop={stop} onConfirmStop={setConfirming} onCancel={() => setConfirming(false)} onCopy={copy} onRetry={retry} />;
}
