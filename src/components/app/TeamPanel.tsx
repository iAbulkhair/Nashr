"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Role } from "@/lib/auth";
import type { TeamPerms } from "./teamPerms";
import ReadOnlyNote from "./ReadOnlyNote";
import { Icon } from "./Icons";
import Scribble from "@/components/Scribble";

type TeamRole = "admin" | "member";
type Row = { email: string; name: string; role: Role; acceptedAt?: string; disabled?: "seats" };
type PendingRow = { id: string; email: string; role: TeamRole; expiresAt: string; invitedBy: string };
/** The GET /api/team body, which `teamView` in src/lib/team.ts builds (the page renders it on the server first). */
export type TeamView = {
  you: { email: string; name: string; role: Role };
  seats: { used: number; limit: number };
  members: Row[];
  invites: PendingRow[];
};
type Result = { ok: boolean; status: number; j: Record<string, unknown> };

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const day = (iso?: string) => (iso ?? "").slice(0, 10);
const ROLE_BADGE: Record<Role, string> = { owner: "badge badge-accent", admin: "badge badge-primary", member: "badge bg-ink/10 text-ink/70" };

/** One JSON call. `ok` only when the server said `ok: true`; a network failure reads as a failed call, never as success. */
async function call(url: string, method: string, body?: unknown): Promise<Result> {
  try {
    const res = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && j.ok === true, status: res.status, j };
  } catch {
    return { ok: false, status: 0, j: {} };
  }
}

/**
 * The Members page: seats, the roster, invites and leaving (docs/superpowers/specs/2026-09-29-teams-design.md §6-7).
 * `perms` comes from `can()` on the server; every action is refused by /api/team/* for the same roles regardless.
 * The page is named "Members" because the AI agents are already "the team" across the app.
 */
export default function TeamPanel({ t, lang, initial, perms, mailOn = true }: { t: AppDict; lang: Lang; initial: TeamView; perms: TeamPerms; /** mail can reach the invited address (`mailReady()`); otherwise the link is handed to the inviter */ mailOn?: boolean }) {
  const T = t.team;
  const router = useRouter();
  const [view, setView] = useState<TeamView>(initial);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const canInvite = perms.inviteMember || perms.inviteAdmin;
  const locked = busy !== "";
  const { used, limit } = view.seats;
  const full = used >= limit;
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));

  const errorText = (r: Result) => {
    const code = r.status === 429 ? "rate_limited" : typeof r.j.error === "string" ? r.j.error : "failed";
    if (code === "seats") return fill(T.errors.seats, { used: Number(r.j.used ?? used), limit: Number(r.j.limit ?? limit) });
    return (T.errors as Record<string, string>)[code] ?? T.errors.failed;
  };
  /** Re-read the roster after every change, so the page shows what the server stored rather than what was asked. */
  async function reload() {
    try {
      const res = await fetch("/api/team");
      const j = (await res.json().catch(() => null)) as TeamView | null;
      if (res.ok && j && Array.isArray(j.members) && Array.isArray(j.invites)) setView(j);
    } catch {
      // Keep what is shown; the next action reloads again.
    }
  }
  async function run(key: string, fn: () => Promise<Result>, after?: (r: Result) => void) {
    setBusy(key); setErr(""); setMsg("");
    const r = await fn();
    if (r.ok) after?.(r);
    else setErr(errorText(r));
    await reload();
    setBusy("");
  }

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const to = email.trim();
    if (!to) return;
    setLink(null); setCopied(false);
    await run("invite", () => call("/api/team/invite", "POST", { email: to, role, lang }), (r) => {
      setEmail("");
      const shown = (r.j.invite as { email?: string } | undefined)?.email ?? to;
      if (r.j.emailed === true) setMsg(fill(T.sent, { email: shown }));
      else if (typeof r.j.link === "string" && r.j.link) {
        // Shown once, only in this component's state: the server keeps no copy of the token.
        const url = r.j.link.startsWith("/") ? `${window.location.origin}${r.j.link}` : r.j.link;
        setLink({ email: shown, url });
      }
    });
  }
  function changeRole(m: Row, next: TeamRole) {
    if (next === m.role) return;
    void run(`role:${m.email}`, () => call("/api/team/member", "PATCH", { email: m.email, role: next }));
  }
  function remove(m: Row) {
    if (!window.confirm(fill(T.confirmRemove, { name: m.name || m.email }))) return;
    void run(`remove:${m.email}`, () => call("/api/team/member", "DELETE", { email: m.email }));
  }
  function cancel(inv: PendingRow) {
    if (!window.confirm(fill(T.confirmCancel, { email: inv.email }))) return;
    void run(`cancel:${inv.id}`, () => call("/api/team/invite", "DELETE", { id: inv.id }));
  }
  async function leave() {
    if (!window.confirm(T.confirmLeave)) return;
    setBusy("leave"); setErr(""); setMsg("");
    const r = await call("/api/team/leave", "POST");
    if (!r.ok) { setErr(errorText(r)); setBusy(""); return; }
    // The route cleared the session cookie; refreshing drops the app shell with it.
    router.push(`/${lang}/app/login`);
    router.refresh();
  }
  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The link stays on screen to copy by hand.
    }
  }

  const canRemove = (m: Row) => m.role !== "owner" && m.email !== view.you.email && (m.role === "admin" ? perms.removeAdmin : perms.removeMember);
  const canCancel = (inv: PendingRow) => perms.cancelInvite && (inv.role === "member" || perms.inviteAdmin);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="teampanel-t1" />{T.title}</span></h1>
      <p className="page-sub">{T.sub}</p>

      <div className="mt-4 card card-sm text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2"><Icon name="users" className="h-4 w-4 text-ink" />{T.seats}: <b className="tnum" dir="ltr">{used} / {limit}</b></span>
          {full && perms.inviteAdmin && <Link href={`/${lang}/app/billing`} className="text-xs font-medium text-ink underline">{T.plans}</Link>}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-label={T.seats} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}>
          <div className={`h-full rounded-full ${full ? "bg-lemon" : "bg-ink"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted">{T.seatsNote}</p>
      </div>

      {err && <p role="alert" className="mt-4 text-sm text-danger">{err}</p>}
      {msg && <p role="status" className="mt-4 rounded-lg bg-lilac p-3 text-sm text-ink">{msg}</p>}

      <div className="mt-4 grid gap-4">
        <section className="card">
          <h2 className="card-title">{T.people}</h2>
          <ul className="mt-2 divide-y divide-ink/10">
            {view.members.map((m) => {
              const you = m.email === view.you.email;
              const label = m.name || m.email;
              return (
                <li key={m.email} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${m.disabled ? "opacity-70" : ""}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink/10 font-semibold text-ink" aria-hidden>{label.charAt(0).toUpperCase()}</span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="clip font-medium" dir="auto">{label}</span>
                        <span className={ROLE_BADGE[m.role]}>{T.roles[m.role]}</span>
                        {you && <span className="text-xs text-muted">({T.you})</span>}
                        {m.disabled && <span className="badge badge-danger" title={T.disabledHelp}>{T.disabled}</span>}
                      </p>
                      <p className="clip text-xs text-muted" dir="ltr">{m.email}</p>
                      {m.acceptedAt && <p className="text-xs text-muted">{T.joined} <span className="font-mono" dir="ltr">{day(m.acceptedAt)}</span></p>}
                      {m.disabled && <p className="text-xs text-muted">{T.disabledHelp}</p>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {perms.changeRole && m.role !== "owner" && (
                      <select aria-label={fill(T.changeRole, { name: label })} value={m.role} disabled={locked} onChange={(e) => changeRole(m, e.target.value as TeamRole)} className="input w-auto py-1 text-xs">
                        <option value="member">{T.roles.member}</option>
                        <option value="admin">{T.roles.admin}</option>
                      </select>
                    )}
                    {canRemove(m) && <button type="button" onClick={() => remove(m)} disabled={locked} className="btn btn-danger btn-xs">{busy === `remove:${m.email}` ? "…" : T.remove}</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {canInvite ? (
          <section className="card">
            <h2 className="card-title">{T.invite}</h2>
            <p className="mt-1 text-sm text-muted">{mailOn ? T.inviteSub : T.inviteSubHand}</p>
            <form onSubmit={invite} className="mt-3 flex flex-wrap items-end gap-2">
              <label className="grid min-w-[14rem] flex-1 gap-1 text-sm">
                <span className="text-ink/70">{T.email}</span>
                <input type="email" required dir="ltr" autoComplete="off" maxLength={120} value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-ink/70">{T.role}</span>
                <select value={role} onChange={(e) => setRole(e.target.value as TeamRole)} className="input w-auto">
                  {perms.inviteMember && <option value="member">{T.roles.member}</option>}
                  {perms.inviteAdmin && <option value="admin">{T.roles.admin}</option>}
                </select>
              </label>
              <button disabled={locked || full} className="btn btn-primary btn-sm">{busy === "invite" ? T.sending : mailOn ? T.send : T.createLink}</button>
            </form>
            <p className="mt-2 text-xs text-muted">{T.roleHelp[role]}</p>
            {full && <p className="mt-2 text-sm text-danger">{perms.inviteAdmin ? T.seatsFull : T.seatsFullAsk}</p>}
            {link && (
              <div className="mt-4 rounded-lg border border-ink/30 bg-ink/5 p-3">
                <p className="text-sm font-medium">{T.linkTitle}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-lilac px-3 py-2 text-xs" dir="ltr">{link.url}</code>
                  <button type="button" onClick={copy} className="btn btn-primary btn-xs"><Icon name="copy" className="h-3.5 w-3.5" />{copied ? T.copied : T.copy}</button>
                </div>
                <p className="mt-2 text-xs text-muted">{fill(T.linkNote, { email: link.email })}</p>
              </div>
            )}
          </section>
        ) : (
          <ReadOnlyNote className="" text={perms.impersonating ? T.impersonating : T.readOnly} />
        )}

        {perms.viewInvites && (
          <section className="card">
            <h2 className="card-title">{T.pending}</h2>
            {view.invites.length === 0 ? (
              <p className="mt-1 text-sm text-muted">{T.noPending}</p>
            ) : (
              <ul className="mt-2 divide-y divide-ink/10">
                {view.invites.map((inv) => (
                  <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2"><span className="clip font-medium" dir="ltr">{inv.email}</span><span className={ROLE_BADGE[inv.role]}>{T.roles[inv.role]}</span></p>
                      <p className="mt-0.5 text-xs text-muted">{T.expires} <span className="font-mono" dir="ltr">{day(inv.expiresAt)}</span> · {T.invitedBy} <span dir="ltr">{inv.invitedBy}</span></p>
                    </div>
                    {canCancel(inv) && <button type="button" onClick={() => cancel(inv)} disabled={locked} className="btn btn-danger btn-xs">{busy === `cancel:${inv.id}` ? "…" : T.cancel}</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {perms.leave && (
          <section className="card">
            <h2 className="card-title">{T.leave}</h2>
            <p className="mt-1 text-sm text-muted">{T.leaveSub}</p>
            <button type="button" onClick={leave} disabled={locked} className="btn btn-danger btn-sm mt-3">{busy === "leave" ? "…" : T.leave}</button>
          </section>
        )}
      </div>
    </div>
  );
}
