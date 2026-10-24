"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/lib/admin-fetch";
import { FormDialog } from "@/components/ui/Dialog";
import { Field, Input, Select } from "@/components/ui/Field";
import Button from "@/components/ui/Button";
import { SW, staffError, type Lang } from "@/lib/staff-words";
import { formatTime } from "@/lib/format";
import type { StaffView } from "@/lib/staff-admin";

type Act = { kind: "create" } | { kind: "invite" } | { kind: "disable" | "enable" | "reset"; who: StaffView } | { kind: "role"; who: StaffView; role: "owner" | "support" } | { kind: "path" };

const post = (url: string, body: Record<string, unknown>) =>
  adminFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * The Staff page (rules 1638-1640, 1650). Every action opens a form with its reason (rule 1185) and a new authenticator
 * code (rule 1636); a key session's reset asks for the console code instead. A created login's setup code and a reset
 * code are shown once, in a dialog, and never put in a URL. "Invite by email" (rule 3706) mails a single-use link valid
 * 24 hours; only when the mail could not go is the link shown once here, to hand over in person.
 */
export default function StaffAdmin({ lang, me, keySession, pathOff }: { lang: Lang; me: string | null; keySession: boolean; pathOff: boolean }) {
  const S = SW[lang];
  const router = useRouter();
  const [list, setList] = useState<StaffView[] | null>(null);
  const [note, setNote] = useState("");
  const [act, setAct] = useState<Act | null>(null);
  const [shown, setShown] = useState<{ email: string; code: string } | null>(null);
  const [invited, setInvited] = useState<{ email: string; link?: string } | null>(null);
  const [closed, setClosed] = useState(pathOff);

  // The list, read again after every change (`tick`).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let gone = false;
    adminFetch("/api/admin/staff", { cache: "no-store" })
      .then(async (r) => ({ r, j: (await r.json().catch(() => ({}))) as { ok?: boolean; staff?: StaffView[]; error?: string } }))
      .then(({ r, j }) => {
        if (gone) return;
        if (j.ok && Array.isArray(j.staff)) { setList(j.staff); setNote(""); }
        else if (r.status !== 401) setNote(staffError(lang, j.error));
      })
      .catch(() => { if (!gone) setNote(staffError(lang, "failed")); });
    return () => { gone = true; };
  }, [lang, tick]);

  async function run(data: FormData): Promise<string | null> {
    if (!act) return null;
    const reason = String(data.get("reason") ?? "");
    const code = String(data.get("code") ?? "").trim();
    let r: Response;
    if (act.kind === "path") r = await post("/api/admin/staff/config", { customerPathOff: true, reason, code });
    else if (act.kind === "create") r = await post("/api/admin/staff", { action: "create", role: "owner", email: String(data.get("email") ?? ""), name: String(data.get("name") ?? ""), reason, code });
    else if (act.kind === "invite") r = await post("/api/admin/staff", { action: "invite", role: String(data.get("role") ?? ""), email: String(data.get("email") ?? ""), name: String(data.get("name") ?? ""), lang, reason, code });
    else r = await post("/api/admin/staff", { action: act.kind, email: act.who.email, ...(act.kind === "role" ? { role: act.role } : {}), reason, code });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; email?: string; mailed?: boolean; link?: string };
    if (!j.ok) return r.status === 429 ? staffError(lang, "slow_down") : staffError(lang, j.error);
    if (j.code && j.email) setShown({ email: j.email, code: j.code });
    if (act.kind === "invite" && j.email) setInvited({ email: j.email, link: j.mailed ? undefined : j.link });
    if (act.kind === "path") { setClosed(true); router.refresh(); }
    setTick((t) => t + 1);
    return null;
  }

  const date = (iso: string | null) => (iso ? formatTime(iso, lang, "datetime") || S.never : S.never);
  const title = (a: Act) =>
    a.kind === "create" ? S.add : a.kind === "invite" ? S.invite : a.kind === "path" ? S.pathClose : a.kind === "role" ? (a.role === "owner" ? S.makeOwner : S.makeSupport) : a.kind === "disable" ? S.disable : a.kind === "enable" ? S.enable : S.reset;

  return (
    <section className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="font-display text-2xl font-bold">{S.staffTitle}</h1>
        <p className="text-sm text-foreground-muted">{keySession ? S.keyStaffNote : S.staffNote}</p>
      </div>
      {note && <p role="alert" className="text-sm text-danger">{note}</p>}
      {!keySession && (
        <p className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAct({ kind: "invite" })}>{S.invite}</Button>
          <Button size="sm" variant="secondary" onClick={() => setAct({ kind: "create" })}>{S.add}</Button>
        </p>
      )}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-start text-foreground-muted">
            <tr><th className="p-3 text-start">{S.colName}</th><th className="p-3 text-start">{S.colRole}</th><th className="p-3 text-start">{S.colState}</th><th className="p-3 text-start">{S.colLast}</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {(list ?? []).map((s) => {
              const self = s.email === me;
              return (
                <tr key={s.email} className="border-t border-border" data-testid="staff-row">
                  <td className="p-3"><div className="font-semibold">{s.name}</div><div dir="ltr" className="text-xs text-foreground-muted">{s.email}</div></td>
                  <td className="p-3">{s.role === "owner" ? S.owner : S.support}</td>
                  <td className="p-3">
                    <div>{s.disabled ? S.off : S.active}</div>
                    {!s.passwordSet && <div className="text-xs text-foreground-muted">{S.noPassword}</div>}
                    {s.passwordSet && !s.enrolled && <div className="text-xs text-foreground-muted">{S.notEnrolled}</div>}
                  </td>
                  <td className="p-3 text-xs" dir="auto" suppressHydrationWarning>{date(s.lastSignInAt)}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap justify-end gap-1">
                      {!s.disabled && !self && <Button size="sm" variant="secondary" onClick={() => setAct({ kind: "reset", who: s })}>{S.reset}</Button>}
                      {keySession && s.disabled && <Button size="sm" variant="secondary" onClick={() => setAct({ kind: "enable", who: s })}>{S.enable}</Button>}
                      {!keySession && !self && (s.disabled
                        ? <Button size="sm" variant="secondary" onClick={() => setAct({ kind: "enable", who: s })}>{S.enable}</Button>
                        : <Button size="sm" variant="secondary" onClick={() => setAct({ kind: "disable", who: s })}>{S.disable}</Button>)}
                      {!keySession && !self && <Button size="sm" variant="secondary" onClick={() => setAct({ kind: "role", who: s, role: s.role === "owner" ? "support" : "owner" })}>{s.role === "owner" ? S.makeSupport : S.makeOwner}</Button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!keySession && (
        <div className="card grid gap-2 text-sm" data-testid="customer-path">
          <h2 className="font-semibold">{S.pathTitle}</h2>
          <p className="text-foreground-muted">{closed ? S.pathOffDone : S.pathOn}</p>
          {!closed && <p><Button size="sm" variant="secondary" onClick={() => setAct({ kind: "path" })}>{S.pathClose}</Button></p>}
        </div>
      )}
      {act && (
        <FormDialog
          lang={lang}
          title={title(act)}
          description={act.kind === "create" ? S.addNote : act.kind === "invite" ? S.inviteNote : act.kind === "reset" ? S.resetNote : act.kind === "path" ? S.pathCloseNote : act.who.email}
          submitLabel={S.go}
          cancelLabel={S.cancel}
          busyLabel={S.busy}
          role={act.kind === "disable" || act.kind === "reset" || act.kind === "path" ? "alertdialog" : "dialog"}
          onSubmit={run}
          onClose={() => setAct(null)}
        >
          {(act.kind === "create" || act.kind === "invite") && (
            <>
              <Field label={S.email}><Input name="email" type="email" autoComplete="off" dir="ltr" required /></Field>
              <Field label={S.colName}><Input name="name" autoComplete="off" maxLength={80} required /></Field>
              {act.kind === "invite" && (
                <Field label={S.colRole}>
                  <Select name="role" defaultValue="support"><option value="support">{S.support}</option><option value="owner">{S.owner}</option></Select>
                </Field>
              )}
            </>
          )}
          <Field label={S.reason} hint={S.reasonHint}><Input name="reason" minLength={3} maxLength={200} required /></Field>
          <Field label={keySession ? S.freshCodeKey : S.freshCode}><Input name="code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} /></Field>
        </FormDialog>
      )}
      {invited && (
        <FormDialog lang={lang} title={invited.link ? S.inviteLink : S.invite} role="alertdialog" submitLabel={S.done} cancelLabel={S.cancel} onSubmit={async () => null} onClose={() => setInvited(null)}>
          <p className="text-sm">{invited.link ? S.inviteLinkNote : S.inviteSent}</p>
          <p dir="ltr" className="text-sm text-foreground-muted">{invited.email}</p>
          {invited.link && <p dir="ltr" className="select-all break-all rounded-lg bg-background-muted/60 px-3 py-2 font-mono text-xs" data-testid="invite-link">{invited.link}</p>}
        </FormDialog>
      )}
      {shown && (
        <FormDialog lang={lang} title={S.setupShown} role="alertdialog" submitLabel={S.done} cancelLabel={S.cancel} onSubmit={async () => null} onClose={() => setShown(null)}>
          <p className="text-sm">{S.setupShownNote}</p>
          <p dir="ltr" className="text-sm text-foreground-muted">{shown.email}</p>
          <p dir="ltr" className="select-all rounded-lg bg-background-muted/60 px-3 py-2 text-center font-mono text-base tracking-wider" data-testid="setup-code">{shown.code}</p>
        </FormDialog>
      )}
    </section>
  );
}
