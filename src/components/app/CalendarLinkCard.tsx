"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AppDict } from "@/lib/app-i18n";
import { fill } from "@/lib/fill";
import { refusalText, useOneWrite } from "./useOneWrite";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { useApiHref } from "./useBrandHref";

/**
 * «تقويم التسويق» / "Marketing calendar" on My to-dos (Reem B3, spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §2): the
 * one calendar Reem reads for the brand. Shown to the account owner only (`calendar.link`; the page gates the mount and every
 * route refuses a non-owner). Four states: Not linked, Choose, Linked, Reconnect.
 *
 * Reads GET /api/secretary/calendar-link (the link as the page sees it: never a token, a calendar id or the declaration) and
 * GET /api/secretary/calendar-link/calendars (opaque indexes, not provider ids). Writes (save, disconnect) run one at a time
 * through `useOneWrite`, the way `FeedCard` does. Connect and Reconnect are plain links to /api/connect/{gcal|mscal}/start.
 * The provider's return is `?cal=choose` or `?cal_error=<fixed code>` on the page address: read once on mount, then removed
 * from the address bar with `history.replaceState`. The state itself comes from the link's `state`, not from the address.
 * Everything from the provider (account, calendar name, event titles) is untrusted text: rendered as text with `dir="auto"`,
 * never as markup.
 */

export type CalProviderId = "gcal" | "mscal";
export type CalProviders = { gcal: boolean; mscal: boolean };
type Lost = "token" | "calendar" | "domain" | "brand" | "owner";
const LOST: readonly Lost[] = ["token", "calendar", "domain", "brand", "owner"];
const CAL_ERRORS = ["invalid_state", "session_mismatch", "forbidden", "denied", "brand_inactive", "token_failed", "provider_error"] as const;
type CalErrorCode = (typeof CAL_ERRORS)[number];

/** The link as GET answers it (no token, no calendar id, no declaration). */
export type LinkInfo = {
  provider: CalProviderId; account: string; calendarName?: string; proof: "domain" | "declaration" | null; state: "choose" | "ok" | "reconnect";
  lostReason?: Lost; lastSyncAt?: string; rev: number; today: { start: string; end: string; title: string }[];
};
export type CalChoice = { choice: number; name: string };

/** What the card shows. `choose` holds the calendars listed live (or `null` while they load) and `back` for a change from Linked. */
export type CalState =
  | { kind: "loading" }
  | { kind: "failed"; text?: string }
  | { kind: "none" }
  | { kind: "choose"; link: LinkInfo; calendars: CalChoice[] | null; needsDeclaration: boolean; back: boolean }
  | { kind: "linked"; link: LinkInfo }
  | { kind: "reconnect"; link: LinkInfo };

/** The connector start link for `p`, with the page's brand in the query (R-C13: a navigation cannot carry the header). */
const startPath = (p: CalProviderId, lang: "ar" | "en") => `/api/connect/${p}/start?lang=${lang}`;
const isProvider = (p: unknown): p is CalProviderId => p === "gcal" || p === "mscal";

/** «قبل 4 دقائق» / "4 minutes ago" in Latin digits, from an ISO time; "" when the time does not parse. */
export function sinceText(iso: string, lang: "ar" | "en", now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.max(0, Math.round((now - at) / 60000));
  const f = new Intl.RelativeTimeFormat(lang === "ar" ? "ar-u-nu-latn" : "en", { numeric: "auto" });
  if (mins < 60) return f.format(-mins, "minute");
  if (mins < 60 * 24) return f.format(-Math.round(mins / 60), "hour");
  return f.format(-Math.round(mins / (60 * 24)), "day");
}

/**
 * The card's markup for one state (no fetching, so a test can render each state). `busy` names the running write (`save`,
 * `unlink`, `change`), `confirming` shows the inline "Disconnect?" question, `picked` the chosen calendar index and `declared` the
 * ticked box. `fromError` is the provider's return error code, shown above the card's body. `startHref` builds the Connect and
 * Reconnect links (the card passes them with the page's brand, `useApiHref`), so the view reads nothing but its props.
 */
export function CalendarLinkView({ t, lang, providers, state, now, startHref, busy = null, error = null, confirming = false, picked = null, declared = false, fromError = null, onPick, onDeclare, onSave, onChange, onBack, onRefresh, onConfirmUnlink, onUnlink, onRetry }: {
  t: AppDict; lang: "ar" | "en"; providers: CalProviders; state: CalState; now: number; startHref: (p: CalProviderId) => string; busy?: string | null; error?: string | null; confirming?: boolean;
  picked?: number | null; declared?: boolean; fromError?: CalErrorCode | null;
  onPick?: (choice: number) => void; onDeclare?: (on: boolean) => void; onSave?: () => void; onChange?: () => void; onBack?: () => void; onRefresh?: () => void;
  onConfirmUnlink?: (on: boolean) => void; onUnlink?: () => void; onRetry?: () => void;
}) {
  const T = t.todo.calLink;
  const off = !!busy;
  const connect = (p: CalProviderId, label: string) =>
    providers[p] ? (
      <a href={startHref(p)} className="btn btn-primary btn-sm">{label}</a>
    ) : (
      <span className="btn btn-secondary btn-sm opacity-60" aria-disabled="true">{label} · {T.soon}</span>
    );
  const unlinkRow = (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <p className="w-full text-sm" role="alert">{T.confirmUnlink}</p>
          <button type="button" disabled={off} onClick={() => onUnlink?.()} className="btn btn-primary btn-sm">{busy === "unlink" ? T.unlinking : T.confirmYes}</button>
          <button type="button" disabled={off} onClick={() => onConfirmUnlink?.(false)} className="btn btn-secondary btn-sm">{T.cancel}</button>
        </>
      ) : null}
    </div>
  );
  const link = state.kind === "choose" || state.kind === "linked" || state.kind === "reconnect" ? state.link : null;
  const account = link && (
    <p className="text-sm">
      <span className="text-foreground-muted">{T.accountLabel}: </span>
      <bdi dir="auto" className="break-all">{link.account}</bdi>
    </p>
  );
  return (
    <section id="todo-calendar" aria-labelledby="todo-calendar-title" className="card mt-8 min-w-0">
      <h2 id="todo-calendar-title" className="card-title">{T.title}</h2>
      <p className="mt-1 text-sm text-foreground-muted">{T.sub}</p>
      {fromError && <p role="alert" className="mt-3 rounded-xl border border-foreground/10 px-3 py-2 text-sm text-danger">{T.calError[fromError]}</p>}
      {state.kind === "loading" && <PanelSkeleton className="mt-3" label={T.loading} shape="rows" count={2} />}{/* rule 2003 */}
      {state.kind === "failed" && (
        <div className="mt-3">
          <p role="alert" className="text-sm text-danger">{state.text ?? T.error}</p>
          <button type="button" onClick={() => onRetry?.()} className="btn btn-secondary btn-sm mt-2">{t.handoff.retry}</button>
        </div>
      )}

      {state.kind === "none" && (
        <div className="mt-3 grid gap-3">
          <p className="text-sm">{T.reads}</p>
          <div className="flex flex-wrap items-center gap-2">
            {connect("gcal", T.connectGoogle)}
            {connect("mscal", T.connectOutlook)}
          </div>
          <p className="text-xs text-foreground-muted">{T.googleNote}</p>
        </div>
      )}

      {state.kind === "choose" && (
        <div className="mt-3 grid gap-3">
          {account}
          <div>
            <h3 className="text-sm font-semibold">{T.chooseTitle}</h3>
            <p className="mt-1 text-xs text-foreground-muted">{T.chooseHint}</p>
          </div>
          {state.calendars === null && <PanelSkeleton label={T.loading} shape="line" />}
          {state.calendars !== null && state.calendars.length === 0 && (
            <div className="grid gap-2">
              <p className="text-sm">{T.noCalendars}</p>
              <div><button type="button" disabled={off} onClick={() => onRefresh?.()} className="btn btn-secondary btn-sm">{T.refresh}</button></div>
            </div>
          )}
          {state.calendars !== null && state.calendars.length > 0 && (
            <fieldset className="grid min-w-0 gap-2 border-0 p-0">
              <legend className="sr-only">{T.chooseTitle}</legend>
              {state.needsDeclaration && (
                <label className="flex min-w-0 items-start gap-2 rounded-xl border border-foreground/10 px-3 py-2 text-sm">
                  <input type="checkbox" checked={declared} disabled={off} onChange={(e) => onDeclare?.(e.target.checked)} className="mt-1 shrink-0 accent-foreground" />
                  <span className="min-w-0">{T.declare}</span>
                </label>
              )}
              {state.calendars.map((c) => (
                <label key={c.choice} className="flex min-w-0 items-start gap-2 text-sm">
                  <input type="radio" name="todo-calendar-choice" value={c.choice} checked={picked === c.choice} disabled={off} onChange={() => onPick?.(c.choice)} className="mt-1 shrink-0 accent-foreground" />
                  <bdi dir="auto" className="min-w-0 break-words">{c.name}</bdi>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {state.calendars !== null && state.calendars.length > 0 && (
              <button type="button" disabled={off || picked === null || (state.needsDeclaration && !declared)} onClick={() => onSave?.()} className="btn btn-primary btn-sm">{busy === "save" ? T.saving : T.save}</button>
            )}
            {state.back && <button type="button" disabled={off} onClick={() => onBack?.()} className="btn btn-secondary btn-sm">{T.back}</button>}
            {!confirming && <button type="button" disabled={off} onClick={() => onConfirmUnlink?.(true)} className="btn btn-secondary btn-sm">{T.unlink}</button>}
          </div>
          {unlinkRow}
        </div>
      )}

      {state.kind === "linked" && (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-1">
            <p className="text-sm">
              <span className="text-foreground-muted">{T.calendarLabel}: </span>
              <bdi dir="auto" className="break-words font-semibold">{state.link.calendarName ?? ""}</bdi>
            </p>
            {account}
            <p>
              <span className="inline-block rounded-full border border-border px-2 py-0.5 text-xs">{state.link.proof === "domain" ? T.badgeDomain : T.badgeDeclared}</span>
            </p>
            <p className="text-xs text-foreground-muted">{state.link.lastSyncAt ? fill(T.lastSync, { when: sinceText(state.link.lastSyncAt, lang, now) }) : T.notSynced}</p>
          </div>
          <div>
            <h3 className="text-sm font-semibold">{T.todayTitle}</h3>
            {state.link.today.length === 0 ? (
              <p className="mt-1 text-sm text-foreground-muted">{T.noneToday}</p>
            ) : (
              <ul className="mt-1 grid gap-1 text-sm">
                {state.link.today.map((m, i) => (
                  <li key={i} className="flex min-w-0 flex-wrap gap-x-2">
                    <bdi dir="ltr" className="shrink-0 text-foreground-muted">{m.start}–{m.end}</bdi>
                    <bdi dir="auto" className="min-w-0 break-words">{m.title}</bdi>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {!confirming && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={off} onClick={() => onChange?.()} className="btn btn-secondary btn-sm">{busy === "change" ? T.changing : T.change}</button>
              <button type="button" disabled={off} onClick={() => onConfirmUnlink?.(true)} className="btn btn-secondary btn-sm">{T.unlink}</button>
            </div>
          )}
          {unlinkRow}
        </div>
      )}

      {state.kind === "reconnect" && (
        <div className="mt-3 grid gap-3">
          <div className="rounded-xl border border-foreground/10 px-3 py-2">
            <h3 className="text-sm font-semibold">{T.reconnectTitle}</h3>
            <p className="mt-1 text-sm">{state.link.lostReason && LOST.includes(state.link.lostReason) ? T.lost[state.link.lostReason] : T.lost.token}</p>
            <p className="mt-1 text-xs text-foreground-muted">{T.reconnectNote}</p>
          </div>
          {account}
          {!confirming && (
            <div className="flex flex-wrap items-center gap-2">
              {providers[state.link.provider] ? (
                <a href={startHref(state.link.provider)} className="btn btn-primary btn-sm">{T.reconnect}</a>
              ) : (
                <span className="btn btn-secondary btn-sm opacity-60" aria-disabled="true">{T.reconnect} · {T.soon}</span>
              )}
              <button type="button" disabled={off} onClick={() => onConfirmUnlink?.(true)} className="btn btn-secondary btn-sm">{T.unlink}</button>
            </div>
          )}
          {unlinkRow}
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

/** A GET answer as a card state; anything unexpected is a failure, never a guess. */
function linkOf(j: { link?: unknown }): LinkInfo | null | undefined {
  if (j.link === null) return null;
  const l = j.link as Partial<LinkInfo> | undefined;
  if (!l || !isProvider(l.provider) || typeof l.account !== "string" || typeof l.rev !== "number" || (l.state !== "choose" && l.state !== "ok" && l.state !== "reconnect")) return undefined;
  return { ...(l as LinkInfo), today: Array.isArray(l.today) ? l.today : [] };
}

/**
 * The stateful card. The owner's link status comes from GET /api/secretary/calendar-link; the choose list from GET .../calendars
 * (read when the card enters Choose, never from the address). A save sends `{ choice, declare?, rev }`; a stale or expired answer
 * reloads what the card shows. All text of a refusal is the page's own words (`refusalText`).
 */
export default function CalendarLinkCard({ t, lang, providers }: { t: AppDict; lang: "ar" | "en"; providers: CalProviders }) {
  const T = t.todo.calLink;
  const apiHref = useApiHref();
  const [state, setState] = useState<CalState>({ kind: "loading" });
  const [picked, setPicked] = useState<number | null>(null);
  const [declared, setDeclared] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The provider's return error, taken from the address once (a fixed code only) and kept after the address is cleaned.
  const params = useSearchParams();
  const [fromError] = useState<CalErrorCode | null>(() => {
    const code = params?.get("cal_error") ?? null;
    return code && (CAL_ERRORS as readonly string[]).includes(code) ? (code as CalErrorCode) : null;
  });
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const words: Record<string, string> = { ...T.errors, bad_request: t.todo.errors.bad_request };
  const { busy, error, send } = useOneWrite(t, words);
  const live = useRef(true);
  // Which listing is current: a slower earlier answer never replaces a newer one.
  const seq = useRef(0);

  // The provider's return (`?cal=choose` or `?cal_error=<code>`) is taken off the address bar; the card's state comes from the link.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      if (!q.has("cal") && !q.has("cal_error")) return;
      q.delete("cal");
      q.delete("cal_error");
      const rest = q.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    } catch {
      // Without the address the card still works from the link's own state.
    }
  }, []);

  // Set again on mount so a development remount (strict mode) does not leave the card deaf to its answers.
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /** Lists the account's own calendars for the Choose state. */
  async function listCalendars(link: LinkInfo, back: boolean) {
    const mine = ++seq.current;
    setPicked(null);
    setDeclared(false);
    setState({ kind: "choose", link, calendars: null, needsDeclaration: true, back });
    try {
      const r = await fetch("/api/secretary/calendar-link/calendars", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: unknown; calendars?: unknown; needsDeclaration?: unknown };
      if (!live.current || mine !== seq.current) return;
      if (!r.ok || !j.ok || !Array.isArray(j.calendars)) {
        setState({ kind: "failed", text: refusalText(t, r.status, j.error, words) });
        return;
      }
      const calendars = j.calendars.filter((c): c is CalChoice => !!c && typeof (c as CalChoice).choice === "number" && typeof (c as CalChoice).name === "string");
      setState({ kind: "choose", link, calendars, needsDeclaration: j.needsDeclaration !== false, back });
    } catch {
      if (live.current && mine === seq.current) setState({ kind: "failed" });
    }
  }

  /** Reads the link and shows the state it is in. */
  useEffect(() => {
    const mine = ++seq.current;
    fetch("/api/secretary/calendar-link", { cache: "no-store" })
      .then(async (r) => ({ status: r.status, ok: r.ok, j: (await r.json().catch(() => ({}))) as { ok?: boolean; error?: unknown; link?: unknown } }))
      .then(({ status, ok, j }) => {
        if (!live.current || mine !== seq.current) return;
        if (!ok || !j.ok) return setState({ kind: "failed", text: refusalText(t, status, j.error, words) });
        const link = linkOf(j);
        if (link === undefined) return setState({ kind: "failed" });
        setNow(Date.now());
        if (link === null) return setState({ kind: "none" });
        if (link.state === "reconnect") return setState({ kind: "reconnect", link });
        if (link.state === "choose" || !link.calendarName) return void listCalendars(link, false);
        setState({ kind: "linked", link });
      })
      .catch(() => live.current && mine === seq.current && setState({ kind: "failed" }));
    // `t`, `words` and `lang` do not change while the page is open: the read runs on mount and on "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  function retry() {
    setState({ kind: "loading" });
    setConfirming(false);
    setAttempt((n) => n + 1);
  }

  async function save() {
    if (state.kind !== "choose" || picked === null) return;
    const { link, needsDeclaration, back } = state;
    const body = { choice: picked, rev: link.rev, ...(needsDeclaration && declared ? { declare: true as const } : {}) };
    const j = await send("save", "/api/secretary/calendar-link", "PUT", body, (status) => {
      // A changed or expired link is read again so the card shows what is true now; a refusal about the declaration or the
      // ownership lists the calendars again, so the box and the choices match what the provider says now.
      if (status === 409) retry();
      else if (status === 400) void listCalendars(link, back);
    });
    const saved = j ? linkOf(j) : null;
    if (saved && saved.state === "ok") {
      setNow(Date.now());
      setState({ kind: "linked", link: saved });
    }
  }
  async function change() {
    if (state.kind !== "linked") return;
    const link = state.link;
    setConfirming(false);
    await listCalendars(link, true);
  }
  async function unlink() {
    if (await send("unlink", "/api/secretary/calendar-link", "DELETE")) {
      setConfirming(false);
      setPicked(null);
      setDeclared(false);
      setState({ kind: "none" });
    }
  }

  return (
    <CalendarLinkView
      t={t} lang={lang} providers={providers} state={state} now={now} startHref={(p) => apiHref(startPath(p, lang))} busy={busy} error={error?.text ?? null} confirming={confirming}
      picked={picked} declared={declared} fromError={fromError}
      onPick={setPicked} onDeclare={setDeclared} onSave={save} onChange={change} onRefresh={() => state.kind === "choose" && void listCalendars(state.link, state.back)}
      onBack={() => { if (state.kind === "choose") { setPicked(null); setDeclared(false); retry(); } }}
      onConfirmUnlink={setConfirming} onUnlink={unlink} onRetry={retry}
    />
  );
}
