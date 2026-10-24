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
import { useConfirm } from "./ConfirmDialog";
import Scribble from "@/components/Scribble";
import { useToast } from "@/components/ui/Toast";
import { useAppLink } from "@/components/app/WorkspaceContext";

/** "member" is the Editor (rule 3751: stored under its old name until the contract release). */
type TeamRole = "admin" | "member" | "viewer";
/** Rules 3756, 3760, 3770: brand scope (absent = every brand), the approve toggle and the monthly cap, shown to managers. */
type Access = { brands?: string[]; approves?: true; creditCap?: number; spent?: number };
type Row = { email: string; name: string; role: Role; acceptedAt?: string; disabled?: "seats" } & Access;
type PendingRow = { id: string; email: string; role: TeamRole; expiresAt: string; invitedBy: string; brands?: string[]; approves?: true };
/** The GET /api/team body, which `teamView` in src/lib/team.ts builds (the page renders it on the server first). */
export type TeamView = {
  you: { email: string; name: string; role: Role };
  seats: { used: number; limit: number; freeViewers?: number; freeViewersLeft?: number };
  members: Row[];
  invites: PendingRow[];
  /** Managers only: the account's active brands for the scope picker, and the approval policy (rule 3762). */
  brands?: { id: string; name: string }[];
  approvalRequired?: boolean;
  /** Owner and admin only (rule 1480): each person's decisions over the last 30 days, keyed by email. */
  approvals?: Record<string, { approved: number; rejected: number; edited: number; rate: number | null }>;
};
type Result = { ok: boolean; status: number; j: Record<string, unknown> };
/** One GET /api/team/log row (`teamLogView` in src/lib/teamlog.ts): addresses only, never a person id. */
type LogRow = { at: string; kind: keyof AppDict["team"]["logKinds"]; actor: { email: string }; target: { email: string }; role?: TeamRole; via: keyof AppDict["team"]["logVia"] };
/** The owner's pending ownership offer (`pendingTransfer`): the address and the expiry, never the token. */
export type TransferOffer = { email: string; expiresAt: string };

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const day = (iso?: string) => (iso ?? "").slice(0, 10);
const ROLE_BADGE: Record<Role, string> = { owner: "badge badge-accent", admin: "badge badge-primary", member: "badge bg-foreground/10 text-foreground-muted", viewer: "badge border border-foreground/20 text-foreground-muted" };
const ROLE_ORDER: TeamRole[] = ["viewer", "member", "admin"];

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
export default function TeamPanel({ t, lang, initial, perms, mailOn = true, transfer = null }: { t: AppDict; lang: Lang; initial: TeamView; perms: TeamPerms; /** mail can reach the invited address (`mailReady()`); otherwise the link is handed to the inviter */ mailOn?: boolean; /** the pending ownership offer, for the owner (multi-workspace M3) */ transfer?: TransferOffer | null }) {
  const href = useAppLink(lang);
  const T = t.team;
  const router = useRouter();
  const [view, setView] = useState<TeamView>(initial);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  // The new invite's brand scope (null = every brand) and approve toggle (rules 3756, 3760).
  const [scope, setScope] = useState<string[] | null>(null);
  const [approves, setApproves] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Remove, cancel and leave ask in the app's own dialog: each answer is "Go back" or the row's own action.
  const [ask, confirmDialog] = useConfirm();
  const toast = useToast();
  // Multi-workspace M3: the Team log (read on demand) and the ownership offer. Both sections show only with MULTI_ORG on (`perms`).
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [offer, setOffer] = useState<TransferOffer | null>(transfer);
  const [xTo, setXTo] = useState("");
  const [xPw, setXPw] = useState("");
  const [xCode, setXCode] = useState("");

  const canInvite = perms.inviteMember || perms.inviteAdmin;
  const locked = busy !== "";
  const { used, limit } = view.seats;
  const full = used >= limit;
  const freeLeft = view.seats.freeViewersLeft ?? 0;
  // A viewer within the free viewers takes no seat (rule 3753), so a full plan still lets one be invited.
  const blocked = full && !(role === "viewer" && freeLeft > 0);
  const brands = view.brands ?? [];
  const scoping = perms.access && brands.length > 1;
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));

  const errorCode = (r: Result) => r.status === 429 ? "rate_limited" : typeof r.j.error === "string" ? r.j.error : "failed";
  const errorText = (r: Result) => {
    const code = errorCode(r);
    if (code === "seats") return fill(T.errors.seats, { used: Number(r.j.used ?? used), limit: Number(r.j.limit ?? limit) });
    return (T.errors as Record<string, string>)[code] ?? T.errors.failed;
  };
  /** Rule 2001: a plain "could not do it" is a toast; a refusal the person must act on (seats, rate, role, address) stays in the alert. */
  const fail = (r: Result) => {
    const code = errorCode(r);
    if (code === "failed" || !(code in T.errors)) { setErr(""); toast.danger(errorText(r)); } else setErr(errorText(r));
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
    setBusy(key); setErr("");
    const r = await fn();
    if (r.ok) after?.(r);
    else fail(r);
    await reload();
    setBusy("");
  }

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const to = email.trim();
    if (!to) return;
    setLink(null); setCopied(false);
    const access = perms.access ? { ...(scoping && scope ? { brands: scope } : {}), ...(role !== "admin" && approves ? { approves: true } : {}) } : {};
    await run("invite", () => call("/api/team/invite", "POST", { email: to, role, lang, ...access }), (r) => {
      setEmail(""); setScope(null); setApproves(false);
      const shown = (r.j.invite as { email?: string } | undefined)?.email ?? to;
      if (r.j.emailed === true) toast.success(fill(T.sent, { email: shown })); // rule 2001
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
  function saveAccess(m: Row, next: { brands: string[] | null; approves: boolean; creditCap: number | null | undefined }) {
    const body: Record<string, unknown> = { email: m.email };
    if (perms.access) {
      if (scoping) body.brands = next.brands;
      if (m.role !== "admin") body.approves = next.approves;
    }
    if (perms.cap && next.creditCap !== undefined) body.creditCap = next.creditCap;
    void run("access:" + m.email, () => call("/api/team/member", "PATCH", body), () => toast.success(T.saved));
  }
  function setPolicy(on: boolean) {
    void run("policy", () => call("/api/team", "PATCH", { approvalRequired: on }));
  }
  async function remove(m: Row) {
    const label = m.name || m.email;
    if (!(await ask({ title: label, message: fill(T.confirmRemove, { name: label }), confirmLabel: T.remove, cancelLabel: t.dialog.back, destructive: true }))) return;
    void run(`remove:${m.email}`, () => call("/api/team/member", "DELETE", { email: m.email }));
  }
  async function cancel(inv: PendingRow) {
    if (!(await ask({ title: inv.email, message: fill(T.confirmCancel, { email: inv.email }), confirmLabel: T.cancel, cancelLabel: t.dialog.back, destructive: true }))) return;
    void run(`cancel:${inv.id}`, () => call("/api/team/invite", "DELETE", { id: inv.id }));
  }
  async function leave() {
    if (!(await ask({ title: T.leave, message: T.confirmLeave, confirmLabel: T.leave, cancelLabel: t.dialog.back, destructive: true }))) return;
    setBusy("leave"); setErr("");
    const r = await call("/api/team/leave", "POST");
    if (!r.ok) { fail(r); setBusy(""); return; }
    // The route cleared the session cookie; refreshing drops the app shell with it.
    router.push(`/${lang}/app/login`);
    router.refresh();
  }
  async function showLog() {
    setBusy("log"); setErr("");
    const r = await call("/api/team/log", "GET");
    if (r.ok && Array.isArray(r.j.rows)) setLog(r.j.rows as LogRow[]);
    else fail(r);
    setBusy("");
  }
  async function offerTransfer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!xTo || !xPw) return;
    if (!(await ask({ title: T.transfer, message: fill(T.confirmTransfer, { email: xTo }), confirmLabel: T.transferSend, cancelLabel: t.dialog.back, destructive: true }))) return;
    await run("transfer", () => call("/api/team/transfer", "POST", { email: xTo, password: xPw, ...(xCode.trim() ? { code: xCode.trim() } : {}) }), (r) => {
      const o = r.j.offer as TransferOffer | undefined;
      if (o && typeof o.email === "string") setOffer(o);
      setXPw(""); setXCode("");
      toast.success(fill(T.transferSent, { email: o?.email ?? xTo }));
    });
  }
  async function withdraw() {
    await run("transfer:cancel", () => call("/api/team/transfer", "DELETE"), () => setOffer(null));
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
  const canCancel = (inv: PendingRow) => perms.cancelInvite && (inv.role !== "admin" || perms.inviteAdmin);
  const scopeLabel = (ids?: string[]) => (!ids ? T.brandsAll : ids.length === 1 ? brands.find((b) => b.id === ids[0])?.name ?? ids[0] : fill(T.brandsSome, { n: ids.length }));
  const admins = view.members.filter((m) => m.role === "admin" && !m.disabled);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="teampanel-t1" />{T.title}</span></h1>
      <p className="page-sub">{T.sub}</p>

      <div className="mt-4 card card-sm text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2"><Icon name="users" className="h-4 w-4 text-foreground" />{T.seats}: <b className="tnum" dir="ltr">{used} / {limit}</b></span>
          {full && perms.inviteAdmin && <Link href={href("/settings/billing")} className="text-xs font-medium text-foreground underline">{T.plans}</Link>}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/10" role="progressbar" aria-label={T.seats} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}>
          <div className={`h-full rounded-full ${full ? "bg-lemon" : "bg-foreground"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-foreground-muted">{T.seatsNote}</p>
        {view.seats.freeViewers !== undefined && <p className="mt-1 text-xs text-foreground-muted" data-free-viewers>{fill(T.freeViewers, { left: freeLeft, total: view.seats.freeViewers })}</p>}
      </div>

      {view.approvalRequired !== undefined && (
        <div className="mt-4 card card-sm text-sm" data-approval-policy>
          <label className={`flex items-start gap-3 ${perms.policy ? "cursor-pointer" : ""}`}>
            <input type="checkbox" className="mt-1" checked={view.approvalRequired} disabled={!perms.policy || locked} onChange={(e) => setPolicy(e.target.checked)} />
            <span>
              <span className="font-medium">{T.policy}</span> <span className="text-xs text-foreground-muted">({view.approvalRequired ? T.policyOn : T.policyOff})</span>
              <span className="mt-0.5 block text-xs text-foreground-muted">{T.policyHelp}</span>
            </span>
          </label>
        </div>
      )}

      {err && <p role="alert" className="mt-4 text-sm text-danger">{err}</p>}

      <div className="mt-4 grid gap-4">
        <section className="card">
          <h2 className="card-title">{T.people}</h2>
          <ul className="mt-2 divide-y divide-foreground/10">
            {view.members.map((m) => {
              const you = m.email === view.you.email;
              const label = m.name || m.email;
              return (
                <li key={m.email} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${m.disabled ? "opacity-70" : ""}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-foreground/10 font-semibold text-foreground" aria-hidden>{label.charAt(0).toUpperCase()}</span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="clip font-medium" dir="auto">{label}</span>
                        <span className={ROLE_BADGE[m.role]}>{T.roles[m.role]}</span>
                        {you && <span className="text-xs text-foreground-muted">({T.you})</span>}
                        {m.disabled && <span className="badge badge-danger" title={T.disabledHelp}>{T.disabled}</span>}
                      </p>
                      <p className="clip text-xs text-foreground-muted" dir="ltr">{m.email}</p>
                      {m.acceptedAt && <p className="text-xs text-foreground-muted">{T.joined} <span className="font-mono" dir="ltr">{day(m.acceptedAt)}</span></p>}
                      {m.disabled && <p className="text-xs text-foreground-muted">{T.disabledHelp}</p>}
                      {(perms.access || perms.cap) && m.role !== "owner" && (
                        <p className="text-xs text-foreground-muted" data-access-summary>
                          {T.brands}: {scopeLabel(m.brands)}
                          {(m.role === "admin" || m.approves) && <> · {T.approves}</>}
                          {typeof m.creditCap === "number" && <> · {T.cap}: <span className="tnum" dir="ltr">{m.spent ?? 0} / {m.creditCap}</span></>}
                        </p>
                      )}
                      {view.approvals?.[m.email] && (() => {
                        const s = view.approvals[m.email];
                        return <p className="text-xs text-foreground-muted" data-approvals>{lang === "ar" ? `آخر 30 يوماً: وافق على ${s.approved}، رفض ${s.rejected}، عدّل ${s.edited}${s.rate === null ? "" : ` · نسبة الموافقة ${s.rate}%`}` : `Last 30 days: approved ${s.approved}, rejected ${s.rejected}, edited ${s.edited}${s.rate === null ? "" : ` · approval rate ${s.rate}%`}`}</p>;
                      })()}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {perms.changeRole && m.role !== "owner" && (
                      <select aria-label={fill(T.changeRole, { name: label })} value={m.role} disabled={locked} onChange={(e) => changeRole(m, e.target.value as TeamRole)} className="input w-auto py-1 text-xs">
                        {ROLE_ORDER.map((r) => <option key={r} value={r}>{T.roles[r]}</option>)}
                      </select>
                    )}
                    {canRemove(m) && <button type="button" onClick={() => remove(m)} disabled={locked} className="btn btn-danger btn-xs">{busy === `remove:${m.email}` ? "…" : T.remove}</button>}
                  </div>
                  {m.role !== "owner" && !you && (m.role === "admin" ? perms.changeRole || perms.cap : perms.access || perms.cap) && (
                    <AccessEditor key={`${m.email}:${(m.brands ?? []).join(",")}:${m.approves ? 1 : 0}:${m.creditCap ?? ""}`} T={T} row={m} brands={brands} scoping={scoping && (m.role !== "admin" || perms.changeRole)} toggle={perms.access && m.role !== "admin"} cap={perms.cap} locked={locked} onSave={(next) => saveAccess(m, next)} />
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {canInvite ? (
          <section className="card">
            <h2 className="card-title">{T.invite}</h2>
            <p className="mt-1 text-sm text-foreground-muted">{mailOn ? T.inviteSub : T.inviteSubHand}</p>
            <form onSubmit={invite} className="mt-3 flex flex-wrap items-end gap-2">
              <label className="grid min-w-[14rem] flex-1 gap-1 text-sm">
                <span className="text-foreground-muted">{T.email}</span>
                <input type="email" required dir="ltr" autoComplete="off" maxLength={120} value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-foreground-muted">{T.role}</span>
                <select value={role} onChange={(e) => setRole(e.target.value as TeamRole)} className="input w-auto">
                  {perms.inviteMember && <option value="viewer">{T.roles.viewer}</option>}
                  {perms.inviteMember && <option value="member">{T.roles.member}</option>}
                  {perms.inviteAdmin && <option value="admin">{T.roles.admin}</option>}
                </select>
              </label>
              <button disabled={locked || blocked} className="btn btn-primary btn-sm">{busy === "invite" ? T.sending : mailOn ? T.send : T.createLink}</button>
            </form>
            <p className="mt-2 text-xs text-foreground-muted">{T.roleHelp[role]}</p>
            {perms.access && (scoping || role !== "admin") && (
              <div className="mt-3 grid gap-2 text-sm" data-invite-access>
                {scoping && <BrandPicker T={T} brands={brands} value={scope} onChange={setScope} disabled={locked} />}
                {role !== "admin" && (
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={approves} disabled={locked} onChange={(e) => setApproves(e.target.checked)} />
                    <span>{T.approves}<span className="block text-xs text-foreground-muted">{T.approvesHelp}</span></span>
                  </label>
                )}
              </div>
            )}
            {blocked && <p className="mt-2 text-sm text-danger">{perms.inviteAdmin ? T.seatsFull : T.seatsFullAsk}</p>}
            {link && (
              <div className="mt-4 rounded-lg border border-foreground/30 bg-foreground/5 p-3">
                <p className="text-sm font-medium">{T.linkTitle}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-background-muted px-3 py-2 text-xs" dir="ltr">{link.url}</code>
                  <button type="button" onClick={copy} className="btn btn-primary btn-xs"><Icon name="copy" className="h-3.5 w-3.5" />{copied ? T.copied : T.copy}</button>
                </div>
                <p className="mt-2 text-xs text-foreground-muted">{fill(T.linkNote, { email: link.email })}</p>
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
              <p className="mt-1 text-sm text-foreground-muted">{T.noPending}</p>
            ) : (
              <ul className="mt-2 divide-y divide-foreground/10">
                {view.invites.map((inv) => (
                  <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2"><span className="clip font-medium" dir="ltr">{inv.email}</span><span className={ROLE_BADGE[inv.role]}>{T.roles[inv.role]}</span>{(perms.access && (inv.brands || inv.approves)) && <span className="text-xs text-foreground-muted">{scopeLabel(inv.brands)}{inv.approves ? ` · ${T.approves}` : ""}</span>}</p>
                      <p className="mt-0.5 text-xs text-foreground-muted">{T.expires} <span className="font-mono" dir="ltr">{day(inv.expiresAt)}</span> · {T.invitedBy} <span dir="ltr">{inv.invitedBy}</span></p>
                    </div>
                    {canCancel(inv) && <button type="button" onClick={() => cancel(inv)} disabled={locked} className="btn btn-danger btn-xs">{busy === `cancel:${inv.id}` ? "…" : T.cancel}</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {perms.viewLog && (
          <section className="card" data-team-log>
            <h2 className="card-title">{T.log}</h2>
            <p className="mt-1 text-sm text-foreground-muted">{T.logSub}</p>
            {log === null ? (
              <button type="button" onClick={showLog} disabled={locked} className="btn btn-secondary btn-sm mt-3">{busy === "log" ? "…" : T.logShow}</button>
            ) : log.length === 0 ? (
              <p className="mt-2 text-sm text-foreground-muted">{T.logEmpty}</p>
            ) : (
              <ul className="mt-2 divide-y divide-foreground/10">
                {log.map((r, k) => (
                  <li key={k} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0" dir="auto">
                      {fill(T.logKinds[r.kind] ?? r.kind, { actor: r.actor.email, target: r.target.email })}
                      {r.role && <span className={`${ROLE_BADGE[r.role]} ms-2`}>{T.roles[r.role]}</span>}
                      {T.logVia[r.via] && <span className="ms-2 text-xs text-foreground-muted">{T.logVia[r.via]}</span>}
                    </span>
                    <span className="font-mono text-xs text-foreground-muted" dir="ltr">{day(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {perms.transfer && (
          <section className="card" data-transfer>
            <h2 className="card-title">{T.transfer}</h2>
            <p className="mt-1 text-sm text-foreground-muted">{T.transferSub}</p>
            {offer ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">{fill(T.transferPending, { email: offer.email, date: day(offer.expiresAt) })}</p>
                <button type="button" onClick={withdraw} disabled={locked} className="btn btn-danger btn-xs">{busy === "transfer:cancel" ? "…" : T.transferCancel}</button>
              </div>
            ) : admins.length === 0 ? (
              <p className="mt-2 text-sm text-foreground-muted">{T.transferNoAdmin}</p>
            ) : (
              <form onSubmit={offerTransfer} className="mt-3 grid gap-2 sm:max-w-md">
                <label className="grid gap-1 text-sm">
                  <span className="text-foreground-muted">{T.transferTo}</span>
                  <select required value={xTo} onChange={(e) => setXTo(e.target.value)} className="input">
                    <option value="">{T.transferPick}</option>
                    {admins.map((m) => <option key={m.email} value={m.email}>{m.name ? `${m.name} (${m.email})` : m.email}</option>)}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-foreground-muted">{T.transferPassword}</span>
                  <input type="password" required autoComplete="current-password" maxLength={200} value={xPw} onChange={(e) => setXPw(e.target.value)} className="input" dir="ltr" />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-foreground-muted">{T.transferCode}</span>
                  <input inputMode="numeric" autoComplete="one-time-code" maxLength={12} value={xCode} onChange={(e) => setXCode(e.target.value)} className="input" dir="ltr" />
                </label>
                <div><button disabled={locked || !xTo || !xPw} className="btn btn-primary btn-sm">{busy === "transfer" ? "…" : T.transferSend}</button></div>
              </form>
            )}
          </section>
        )}

        {perms.leave && (
          <section className="card">
            <h2 className="card-title">{T.leave}</h2>
            <p className="mt-1 text-sm text-foreground-muted">{T.leaveSub}</p>
            <button type="button" onClick={leave} disabled={locked} className="btn btn-danger btn-sm mt-3">{busy === "leave" ? "…" : T.leave}</button>
          </section>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

type TeamDict = AppDict["team"];

/** The brand scope: every brand, or a chosen few of the account's own (rule 3756). The server keeps only its own ids. */
function BrandPicker({ T, brands, value, onChange, disabled }: { T: TeamDict; brands: { id: string; name: string }[]; value: string[] | null; onChange: (v: string[] | null) => void; disabled: boolean }) {
  const all = value === null;
  return (
    <fieldset className="grid gap-1" data-brand-picker>
      <legend className="text-foreground-muted">{T.brands}</legend>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={all} disabled={disabled} onChange={(e) => onChange(e.target.checked ? null : brands.slice(0, 1).map((b) => b.id))} />
        {T.brandsAll}
      </label>
      {!all && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 ps-6">
          {brands.map((b) => (
            <label key={b.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={value.includes(b.id)}
                disabled={disabled || (value.length === 1 && value[0] === b.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, b.id] : value.filter((x) => x !== b.id))}
              />
              <span dir="auto">{b.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** One person's access, edited in place: brand scope, the approve toggle and the owner's monthly credit cap. */
function AccessEditor({ T, row, brands, scoping, toggle, cap, locked, onSave }: {
  T: TeamDict; row: Row; brands: { id: string; name: string }[]; scoping: boolean; toggle: boolean; cap: boolean; locked: boolean;
  onSave: (next: { brands: string[] | null; approves: boolean; creditCap: number | null | undefined }) => void;
}) {
  const [scope, setScope] = useState<string[] | null>(row.brands ?? null);
  const [approves, setApproves] = useState(row.approves === true);
  const [limit, setLimit] = useState(typeof row.creditCap === "number" ? String(row.creditCap) : "");
  if (!scoping && !toggle && !cap) return null;
  const parsed = limit.trim() === "" ? null : Number(limit);
  const capOk = parsed === null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000_000);
  return (
    <details className="w-full rounded-lg bg-foreground/5 px-3 py-2 text-sm" data-access-editor>
      <summary className="cursor-pointer text-xs font-medium">{T.access}</summary>
      <div className="mt-2 grid gap-3">
        {scoping && <BrandPicker T={T} brands={brands} value={scope} onChange={setScope} disabled={locked} />}
        {toggle && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={approves} disabled={locked} onChange={(e) => setApproves(e.target.checked)} />
            <span>{T.approves}<span className="block text-xs text-foreground-muted">{T.approvesHelp}</span></span>
          </label>
        )}
        {cap && (
          <label className="grid max-w-xs gap-1">
            <span>{T.cap}</span>
            <input type="number" inputMode="numeric" min={0} max={10_000_000} step={1} dir="ltr" placeholder={T.capNone} value={limit} disabled={locked} onChange={(e) => setLimit(e.target.value)} className="input" aria-invalid={!capOk} />
            <span className="text-xs text-foreground-muted">{T.capHelp}{typeof row.spent === "number" ? ` · ${fill(T.spent, { n: row.spent })}` : ""}</span>
          </label>
        )}
        <div>
          <button type="button" className="btn btn-primary btn-xs" disabled={locked || !capOk} onClick={() => onSave({ brands: scope, approves, creditCap: cap ? parsed : undefined })}>{T.save}</button>
        </div>
      </div>
    </details>
  );
}
