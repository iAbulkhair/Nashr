"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Field, Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";
import QrCode from "./QrCode";
import { safeNext } from "@/lib/safe-next";
import { SW, staffError, type Lang } from "@/lib/staff-words";

type Stage = "password" | "setup" | "code" | "enrol" | "codes";
type Answer = { ok?: boolean; next?: string; error?: string; locked?: boolean; secret?: string; uri?: string; codes?: string[] };
/** An invite link carries its code in the fragment (rule 3706): browsers never send it to the server or put it in logs. */
const INVITE = /^#invite=([A-Za-z0-9 -]{16,40})$/;

async function send(url: string, body: Record<string, unknown>): Promise<{ status: number; j: Answer }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    return { status: r.status, j: ((await r.json().catch(() => ({}))) as Answer) ?? {} };
  } catch {
    return { status: 0, j: {} };
  }
}

/**
 * The one staff door (rules 1631, 1632, 1639, 1640, 3702-3704, 3706): email and password, then the authenticator code or
 * a recovery code, or the enrolment with the QR code when the person has none yet (no skip). The locked-address code
 * field appears only after the server answers `locked: true`. `mode: "setup"` starts from a setup, reset or invite code
 * instead: typed, read from an invite link's fragment (then removed from the address bar), or, with `handoffEmail`,
 * held in the HttpOnly hand-off cookie the founder's bootstrap set, so only the password is asked. Every step answers
 * through fetch, so nothing secret ever lands in a request URL; the recovery codes are shown once and kept only in
 * this component's state. No link to the break-glass key form: it is reached by its direct address only (rule 3705).
 */
export default function StaffSignIn({ lang, next, mode = "signin", handoffEmail }: { lang: Lang; next?: string; mode?: "signin" | "setup"; handoffEmail?: string }) {
  const S = SW[lang];
  const router = useRouter();
  const first: Stage = mode === "setup" ? "setup" : "password";
  const [stage, setStage] = useState<Stage>(first);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [afterRecovery, setAfterRecovery] = useState(false);
  // Only once the server says the address is locked (rule 3702): then it opens with the password and a code together.
  const [withCode, setWithCode] = useState(false);
  const [invite, setInvite] = useState("");
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const home = safeNext(next).startsWith(`/${lang}/admin`) ? safeNext(next) : `/${lang}/admin`;

  function refused(status: number, j: Answer) {
    if (j.error === "start_again") { setStage(first); setEnrol(null); }
    setErr(status === 429 ? staffError(lang, "slow_down") : staffError(lang, j.error));
  }

  function go(to: string | undefined) {
    if (to === "enrol") { setStage("enrol"); return; }
    if (to === "code") { setStage("code"); return; }
    router.push(home);
    router.refresh();
  }

  useEffect(() => {
    if (mode !== "setup" || handoffEmail) return;
    const m = INVITE.exec(window.location.hash);
    if (!m) return;
    // Out of the address bar and history at once, so the code is not left on screen or in a shared tab.
    window.history.replaceState(null, "", window.location.pathname);
    // The fragment exists only in the browser, so the first render matches the server's and the code arrives after it.
    const code = m[1].replace(/[\s-]/g, "");
    queueMicrotask(() => setInvite(code));
  }, [mode, handoffEmail]);

  useEffect(() => {
    if (stage !== "enrol" || enrol) return;
    let gone = false;
    void send("/api/admin/staff/login/enrol", { action: "start" }).then(({ status, j }) => {
      if (gone) return;
      if (j.ok && j.secret && j.uri) setEnrol({ secret: j.secret, uri: j.uri });
      else refused(status, j);
    });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, enrol]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "");
    setErr("");
    if (stage === "setup" && v("password") !== v("repeat")) { setErr(S.mismatch); return; }
    setBusy(true);
    try {
      if (stage === "password") {
        const code = v("lockedCode").replace(/\s+/g, "");
        const { status, j } = await send("/api/admin/staff/login", { email: v("email"), password: v("password"), ...(code ? { code } : {}) });
        if (j.ok) go(j.next);
        else { refused(status, j); if (j.locked === true) setWithCode(true); }
      } else if (stage === "setup") {
        // The hand-off sends no code: the server reads it from its HttpOnly cookie (rule 3701).
        const code = handoffEmail ? undefined : invite || v("setupCode").trim();
        const { status, j } = await send("/api/admin/staff/setup", { email: handoffEmail ?? v("email"), ...(code ? { code } : {}), password: v("password") });
        if (j.ok) go(j.next); else refused(status, j);
      } else if (stage === "code") {
        const { status, j } = await send("/api/admin/staff/login/code", { code: v("code").trim() });
        if (j.ok && j.next === "enrol") { setAfterRecovery(true); go("enrol"); }
        else if (j.ok) go(undefined);
        else refused(status, j);
      } else if (stage === "enrol") {
        const { status, j } = await send("/api/admin/staff/login/enrol", { action: "confirm", code: v("code").trim() });
        if (j.ok && Array.isArray(j.codes)) { setCodes(j.codes); setStage("codes"); }
        else refused(status, j);
      }
    } finally {
      setBusy(false);
    }
  }

  const groups = (s: string) => s.replace(/(.{4})(?=.)/g, "$1 ");
  const title = stage === "setup" ? S.setupTitle : stage === "code" ? S.codeTitle : stage === "enrol" ? S.enrolTitle : stage === "codes" ? S.saveTitle : S.signInTitle;

  return (
    <div className="mx-auto grid max-w-sm gap-4">
      <h1 className="font-display text-2xl font-bold text-foreground">{title}</h1>
      {stage === "codes" ? (
        <div className="grid gap-3" data-testid="staff-recovery">
          <p className="text-sm text-foreground-muted">{S.saveNote}</p>
          <ul dir="ltr" className="grid grid-cols-2 gap-2 rounded-lg bg-background-muted/60 p-3 font-mono text-sm">
            {codes.map((c) => <li key={c} className="select-all">{c}</li>)}
          </ul>
          <Button onClick={() => { setCodes([]); go(undefined); }}>{S.saved}</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-3" noValidate>
          {stage === "password" && <p className="text-sm text-foreground-muted">{S.signInNote}</p>}
          {stage === "setup" && <p className="text-sm text-foreground-muted">{handoffEmail ? S.handoffNote : invite ? S.inviteOpenNote : S.setupNote}</p>}
          {stage === "code" && <p className="text-sm text-foreground-muted">{S.codeNote}</p>}
          {stage === "enrol" && (
            <>
              {afterRecovery && <p role="status" className="text-sm font-semibold">{S.afterRecovery}</p>}
              <p className="text-sm text-foreground-muted">{S.enrolNote}</p>
              {enrol && (
                <>
                  <QrCode value={enrol.uri} label={S.qrLabel} />
                  <p className="text-sm text-foreground-muted">{S.manual}</p>
                  <p dir="ltr" className="select-all rounded-lg bg-background-muted/60 px-3 py-2 text-center font-mono text-sm tracking-wider">{groups(enrol.secret)}</p>
                  <p className="text-center text-sm"><a className="underline" href={enrol.uri}>{S.openApp}</a></p>
                </>
              )}
            </>
          )}
          {stage === "setup" && handoffEmail && <p dir="ltr" className="rounded-lg bg-background-muted/60 px-3 py-2 text-sm font-medium" data-testid="staff-handoff-email">{handoffEmail}</p>}
          {(stage === "password" || (stage === "setup" && !handoffEmail)) && (
            <Field label={S.email}><Input name="email" type="email" autoComplete="username" dir="ltr" required /></Field>
          )}
          {stage === "password" && <Field label={S.password}><Input name="password" type="password" autoComplete="current-password" dir="ltr" required /></Field>}
          {stage === "password" && withCode && (
            <Field label={S.lockedCode} hint={S.lockedNote}><Input name="lockedCode" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={8} /></Field>
          )}
          {stage === "setup" && (
            <>
              {!handoffEmail && !invite && <Field label={S.setupCode}><Input name="setupCode" autoComplete="one-time-code" dir="ltr" maxLength={40} required /></Field>}
              <Field label={S.newPassword} hint={S.passwordHint}><Input name="password" type="password" autoComplete="new-password" dir="ltr" minLength={12} maxLength={72} required /></Field>
              <Field label={S.repeat}><Input name="repeat" type="password" autoComplete="new-password" dir="ltr" maxLength={72} required /></Field>
            </>
          )}
          {(stage === "code" || stage === "enrol") && (
            <Field label={S.code}><Input name="code" inputMode={stage === "enrol" ? "numeric" : "text"} autoComplete="one-time-code" dir="ltr" maxLength={40} required /></Field>
          )}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button type="submit" loading={busy} loadingText={S.busy} disabled={stage === "enrol" && !enrol}>{stage === "enrol" ? S.confirm : S.next}</Button>
        </form>
      )}
      {stage === "password" && (
        <div className="grid gap-2 text-sm">
          <a className="underline" href={`/${lang}/admin/login/setup`}>{S.toSetup}</a>
          <div className="rounded-lg border border-border p-3" data-testid="staff-first-help">
            <p className="font-semibold text-foreground">{S.firstTitle}</p>
            <p className="text-foreground-muted">{S.firstHelp}</p>
          </div>
        </div>
      )}
      {stage === "setup" && !handoffEmail && <a className="text-sm underline" href={`/${lang}/admin/login`}>{S.toSignIn}</a>}
    </div>
  );
}
