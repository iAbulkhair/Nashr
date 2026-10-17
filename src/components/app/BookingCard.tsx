"use client";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { fill } from "@/lib/fill";
import { formatWhen } from "@/lib/secretary-agenda";
import { refusalText, useOneWrite } from "./useOneWrite";
import { PanelSkeleton } from "@/components/ui/Skeleton";

type Provider = "calcom" | "calendly";

/**
 * One provider's row. `created` holds the Cal.com URL and signing key: component state only (never stored, never in the
 * address, never logged), set from the create answer and nowhere else, so it is gone when the page is left; after that the
 * row is `exists`, with the date (`since`, already written in the page's language) and Renew and Stop. `left` marks a
 * Calendly row that was just stopped: its webhook stays at Calendly until the owner deletes it.
 */
export type BookRow =
  | { kind: "none"; left?: boolean }
  | { kind: "created"; url: string; secret: string }
  | { kind: "exists"; since: string; sameBrand?: boolean };

export type BookingState = { kind: "loading" } | { kind: "failed"; text?: string } | { kind: "ready"; calcom: BookRow; calendly: BookRow };

type Copied = "url" | "secret" | null;

/** The words for the refusals these routes answer (the shared hook falls back to the to-do list's words for the rest). */
export const bookingWords = (T: AppDict["todo"]["booking"]): Record<string, string> => ({ busy: T.busy, forbidden: T.forbidden, calendly_plan: T.calendly_plan, calendly_rejected: T.calendly_rejected, bad_token: T.bad_token });

/** The two rows from the status read's `links` (never a link or a key: only provider, createdAt and sameBrand). */
export function readRows(links: { provider?: unknown; createdAt?: unknown; sameBrand?: unknown }[] | undefined, lang: "ar" | "en"): { calcom: BookRow; calendly: BookRow } {
  const row = (p: Provider): BookRow => {
    const l = (links ?? []).find((x) => x.provider === p);
    return l && typeof l.createdAt === "string" ? { kind: "exists", since: formatWhen(l.createdAt, true, lang, Date.now()), sameBrand: l.sameBrand !== false } : { kind: "none" };
  };
  return { calcom: row("calcom"), calendly: row("calendly") };
}

/**
 * What the Calendly row shows after a renewal failed. The route refuses 400, 403, 409 and 429 before it touches the old
 * link, so the row stays connected. A 422 (Calendly refused) comes after the old record was replaced and the new one
 * revoked: the server holds no Calendly link, so the row is not connected, and the old webhook is left at Calendly. Any other
 * outcome (a server error, no answer at all) is not known here: the status is read again.
 */
export function rowAfterFailedRenew(status: number, row: BookRow): BookRow | "reread" {
  if (status === 400 || status === 403 || status === 409 || status === 429) return row;
  if (status === 422) return { kind: "none", left: true };
  return "reread";
}

/**
 * The card's markup for one state (no fetching, so a test can render each state). `busy` names the running write
 * (`{provider}:{create|renew|stop}`), `error` the refusal and the row it belongs to, `confirming` the row showing the inline
 * "Stop?" question, `copied` which Copy button was pressed, `renewOpen` the Calendly token field opened by Renew. The token
 * field is not controlled: the card reads it from `tokenRef` when the form is sent and clears it at once.
 */
export function BookingView({ t, state, busy = null, error = null, confirming = null, copied = null, renewOpen = false, tokenRef, onConnectCalcom, onConnectCalendly, onStop, onConfirmStop, onCancel, onCopy, onRenewOpen, onRetry }: {
  t: AppDict; state: BookingState; busy?: string | null; error?: { provider: Provider; text: string } | null; confirming?: Provider | null; copied?: Copied; renewOpen?: boolean;
  tokenRef?: RefObject<HTMLInputElement | null>;
  onConnectCalcom?: (key: "create" | "renew") => void; onConnectCalendly?: (e: FormEvent) => void; onStop?: (p: Provider) => void; onConfirmStop?: (p: Provider | null) => void;
  onCancel?: () => void; onCopy?: (which: "url" | "secret", text: string) => void; onRenewOpen?: (on: boolean) => void; onRetry?: () => void;
}) {
  const T = t.todo.booking;
  const off = !!busy;
  const copyRow = (which: "url" | "secret", label: string, text: string) => (
    <div>
      <p className="text-xs text-foreground-muted">{label}</p>
      <div className="mt-1 flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 basis-56 break-all rounded bg-background-muted px-3 py-2 text-xs" dir="ltr">{text}</code>
        <button type="button" onClick={() => onCopy?.(which, text)} aria-label={`${T.copy}: ${label}`} className="btn btn-secondary btn-xs">{copied === which ? T.copied : T.copy}</button>
        <span role="status" aria-live="polite" className="sr-only">{copied === which ? T.copied : ""}</span>
      </div>
    </div>
  );
  const rowError = (p: Provider) => (error && error.provider === p ? <p role="alert" className="mt-2 text-sm text-danger">{error.text}</p> : null);
  /** Renew and Stop (Stop asks first, inline) for a row that has a link. */
  const actions = (p: Provider, onRenew: () => void, renewLabel: string = T.renew) => (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {confirming === p ? (
        <>
          <p className="w-full text-sm" role="alert">{p === "calcom" ? T.confirmStopCalcom : T.confirmStopCalendly}</p>
          <button type="button" disabled={off} onClick={() => onStop?.(p)} className="btn btn-primary btn-sm">{busy === `${p}:stop` ? T.stopping : T.confirmYes}</button>
          <button type="button" disabled={off} onClick={() => onCancel?.()} className="btn btn-secondary btn-sm">{T.cancel}</button>
        </>
      ) : (
        <>
          <button type="button" disabled={off} onClick={onRenew} className="btn btn-secondary btn-sm">{busy === `${p}:renew` ? T.renewing : renewLabel}</button>
          <button type="button" disabled={off} onClick={() => onConfirmStop?.(p)} className="btn btn-secondary btn-sm">{T.stop}</button>
        </>
      )}
    </div>
  );

  const calcomRow = (row: BookRow) => (
    <div className="rounded-xl border border-foreground/10 p-3">
      <h3 className="font-semibold">{T.calcom}</h3>
      {row.kind === "created" ? (
        <div className="mt-3 grid gap-3">
          {copyRow("url", T.url, row.url)}
          {copyRow("secret", T.key, row.secret)}
          <p className="text-xs text-foreground-muted">{T.shownOnce}</p>
          <ol className="grid list-decimal gap-1 ps-5 text-sm text-foreground-muted">
            <li>{T.calcomStepOpen}</li>
            <li>{T.calcomStepPaste}</li>
            <li>{T.calcomStepEvents}</li>
          </ol>
          <p className="rounded-xl border border-foreground/10 px-3 py-2 text-sm">{T.warning}</p>
          <p className="text-xs text-foreground-muted">{T.renewNote}</p>
        </div>
      ) : row.kind === "exists" ? (
        <div className="mt-3 grid gap-2 text-sm">
          <p>{fill(T.since, { date: row.since })}</p>
          {row.sameBrand === false && <p className="text-foreground-muted">{T.otherBrand}</p>}
          <p className="rounded-xl border border-foreground/10 px-3 py-2">{T.warning}</p>
          <p className="text-xs text-foreground-muted">{T.renewNote}</p>
        </div>
      ) : (
        <div className="mt-3">
          <button type="button" disabled={off} onClick={() => onConnectCalcom?.("create")} className="btn btn-primary btn-sm">{busy === "calcom:create" ? T.connecting : T.connect}</button>
        </div>
      )}
      {(row.kind === "created" || row.kind === "exists") && actions("calcom", () => onConnectCalcom?.("renew"))}
      {rowError("calcom")}
    </div>
  );

  const calendlyRow = (row: BookRow) => {
    const exists = row.kind === "exists";
    const form = !exists || renewOpen;
    return (
      <div className="rounded-xl border border-foreground/10 p-3">
        <h3 className="font-semibold">{T.calendly}</h3>
        {exists && (
          <div className="mt-3 grid gap-1 text-sm">
            <p>{fill(T.since, { date: row.since })}</p>
            {row.sameBrand === false && <p className="text-foreground-muted">{T.otherBrand}</p>}
          </div>
        )}
        {form && (
          <form onSubmit={(e) => onConnectCalendly?.(e)} className="mt-3 grid gap-2">
            <label htmlFor="booking-calendly-token" className="text-xs text-foreground-muted">{T.tokenLabel}</label>
            <div className="flex flex-wrap items-start gap-2">
              <input id="booking-calendly-token" ref={tokenRef} type="password" autoComplete="off" spellCheck={false} dir="ltr" disabled={off} className="input min-w-0 flex-1 basis-56" />
              <button type="submit" disabled={off} className="btn btn-primary btn-sm">{busy === "calendly:create" || busy === "calendly:renew" ? T.connecting : exists ? T.renew : T.connect}</button>
            </div>
            <p className="text-xs text-foreground-muted">{T.tokenWhere}</p>
            <p className="text-xs text-foreground-muted">{T.tokenNote}</p>
            <p className="text-xs text-foreground-muted">{T.planNote}</p>
          </form>
        )}
        {(exists || (row.kind === "none" && row.left)) && <p className="mt-3 text-xs text-foreground-muted">{T.calendlyLeft}</p>}
        {exists && actions("calendly", () => onRenewOpen?.(!renewOpen), renewOpen ? T.cancel : T.renew)}
        {rowError("calendly")}
      </div>
    );
  };

  return (
    <section id="todo-booking" aria-labelledby="todo-booking-title" className="card mt-8">
      <h2 id="todo-booking-title" className="card-title">{T.title}</h2>
      <p className="mt-1 text-sm text-foreground-muted">{T.sub}</p>
      {state.kind === "loading" && <PanelSkeleton className="mt-3" label={T.loading} shape="rows" count={2} />}{/* rule 2003 */}
      {state.kind === "failed" && (
        <div className="mt-3">
          <p role="alert" className="text-sm text-danger">{state.text ?? T.error}</p>
          <button type="button" onClick={() => onRetry?.()} className="btn btn-secondary btn-sm mt-2">{t.handoff.retry}</button>
        </div>
      )}
      {state.kind === "ready" && (
        <div className="mt-3 grid gap-3">
          {calcomRow(state.calcom)}
          {calendlyRow(state.calendly)}
        </div>
      )}
    </section>
  );
}

/**
 * «الحجوزات» / "Bookings" on My to-dos (Reem phase 3 B2a, spec section 4): connect Cal.com or Calendly so that a booking
 * becomes a to-do. Every login may manage its own (`booking.manage`; a founder impersonating is refused and the card says
 * so). The status comes from GET /api/secretary/booking (which providers are connected and since when, never a link or a
 * key). Cal.com Connect and Renew POST the page's language and get the URL and signing key once, from that answer only;
 * Calendly sends the pasted token in the POST body, clears the field before the request goes out (so it is empty after a
 * success and after a refusal alike) and keeps it in no state. Stop deletes after an inline confirm. Writes run one at a
 * time (`useOneWrite`).
 */
export default function BookingCard({ t, lang }: { t: AppDict; lang: "ar" | "en" }) {
  const T = t.todo.booking;
  const [state, setState] = useState<BookingState>({ kind: "loading" });
  const [confirming, setConfirming] = useState<Provider | null>(null);
  const [copied, setCopied] = useState<Copied>(null);
  const [renewOpen, setRenewOpen] = useState(false);
  const words = bookingWords(T);
  const { busy, error, send } = useOneWrite(t, words);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  // Bumped by "Try again": the status read runs again.
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/secretary/booking", { cache: "no-store" })
      .then(async (r) => ({ status: r.status, ok: r.ok, j: (await r.json().catch(() => ({}))) as { ok?: boolean; error?: unknown; links?: { provider?: unknown; createdAt?: unknown; sameBrand?: unknown }[] } }))
      .then(({ status, ok, j }) => {
        if (!live) return;
        // A refusal (too many requests, no access) says so in the page's words, as a refused write does.
        if (!ok || !j.ok) return setState({ kind: "failed", text: refusalText(t, status, j.error, words) });
        setState({ kind: "ready", ...readRows(j.links, lang) });
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
  const setRow = (p: Provider, row: BookRow) => setState((s) => (s.kind === "ready" ? { ...s, [p]: row } : s));
  /** Reads the Calendly row again (after a renewal whose outcome is not known); the Cal.com row, which may hold a key shown once, is left alone. */
  async function rereadCalendly() {
    try {
      const r = await fetch("/api/secretary/booking", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; links?: { provider?: unknown; createdAt?: unknown; sameBrand?: unknown }[] };
      if (r.ok && j.ok) setRow("calendly", readRows(j.links, lang).calendly);
    } catch {
      // The row stays as it was; the error under it says the renewal did not work.
    }
  }

  async function connectCalcom(key: "create" | "renew") {
    const j = await send(`calcom:${key}`, "/api/secretary/booking", "POST", { provider: "calcom", lang });
    if (j && typeof j.url === "string" && typeof j.secret === "string") {
      setConfirming(null);
      setCopied(null);
      setRow("calcom", { kind: "created", url: j.url, secret: j.secret });
    }
  }
  async function connectCalendly(e: FormEvent) {
    e.preventDefault();
    // The token is read once and the field is emptied before anything is sent: it is empty after a success and after a refusal.
    const field = tokenRef.current;
    const token = field?.value ?? "";
    if (field) field.value = "";
    const renewing = renewOpen;
    const was: BookRow = state.kind === "ready" ? state.calendly : { kind: "none" };
    const j = await send(renewing ? "calendly:renew" : "calendly:create", "/api/secretary/booking", "POST", { provider: "calendly", token, lang }, (status) => {
      if (!renewing) return;
      // The error stays visible; the row shows what the server now holds.
      const next = rowAfterFailedRenew(status, was);
      if (next === "reread") void rereadCalendly();
      else {
        setRow("calendly", next);
        if (next.kind === "none") setRenewOpen(false);
      }
    });
    if (j) {
      setConfirming(null);
      setRenewOpen(false);
      setRow("calendly", { kind: "exists", since: formatWhen(new Date().toISOString(), true, lang, Date.now()), sameBrand: true });
    }
  }
  async function stop(p: Provider) {
    if (await send(`${p}:stop`, `/api/secretary/booking?provider=${p}`, "DELETE")) {
      setConfirming(null);
      setCopied(null);
      setRenewOpen(false);
      setRow(p, p === "calendly" ? { kind: "none", left: true } : { kind: "none" });
    }
  }
  async function copy(which: "url" | "secret", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      // The text stays on screen to copy by hand.
    }
  }

  const provider: Provider | null = error ? (error.key.startsWith("calendly") ? "calendly" : "calcom") : null;
  return (
    <BookingView t={t} state={state} busy={busy} error={error && provider ? { provider, text: error.text } : null} confirming={confirming} copied={copied} renewOpen={renewOpen} tokenRef={tokenRef}
      onConnectCalcom={connectCalcom} onConnectCalendly={connectCalendly} onStop={stop} onConfirmStop={setConfirming} onCancel={() => setConfirming(null)} onCopy={copy} onRenewOpen={setRenewOpen} onRetry={retry} />
  );
}
