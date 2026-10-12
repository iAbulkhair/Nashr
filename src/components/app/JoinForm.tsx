"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import { passwordChecks, unmetRules } from "@/lib/auth-client";
import { PasswordRules } from "./PasswordRules";
import PasswordField from "./PasswordField";
import { forgetInviteToken, readInviteToken, recallInviteToken, rememberInviteToken, withoutFragment } from "./inviteToken";
import Scribble from "@/components/Scribble";

type Preview = { team: string; inviter: string; email: string; role: "admin" | "member"; expiresAt: string };
type Phase = "checking" | "signedIn" | "none" | "invalid" | "ready";

/** Fill "{key}" slots with nodes, so names typed by other people render as text inside the sentence, never as markup. */
function parts(s: string, v: Record<string, React.ReactNode>) {
  return s.split(/\{(\w+)\}/).map((p, i) => (i % 2 ? <Fragment key={i}>{v[p] ?? `{${p}}`}</Fragment> : p));
}

/**
 * Accept a team invite (POST /api/team/accept). `{token}` alone previews the invite without consuming it, so mail
 * scanners that open the link cannot burn it; `{token, name, password, lang}` creates the member login and signs it in.
 * A visitor who is already signed in is never joined into that session: they are asked to log out first.
 */
export default function JoinForm({ t, lang, signedInAs }: { t: AppDict; lang: Lang; signedInAs: string | null }) {
  const J = t.join;
  const r = useRouter();
  const token = useRef("");
  const [phase, setPhase] = useState<Phase>(signedInAs ? "signedIn" : "checking");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const checks = passwordChecks(pw);

  useEffect(() => {
    // Read once (the ref survives React's development double-run), then take the token out of the address bar and history.
    // It is kept for this tab (sessionStorage) so the language switch, which reloads the page without the fragment, finds it.
    token.current ||= readInviteToken(window.location.hash) || recallInviteToken();
    if (token.current) rememberInviteToken(token.current);
    if (window.location.hash) window.history.replaceState(window.history.state, "", withoutFragment(window.location));
    const tok = token.current;
    void Promise.resolve().then(async () => {
      if (signedInAs) return;
      if (!tok) return setPhase("none");
      try {
        const res = await fetch("/api/team/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tok }) });
        const j = (await res.json().catch(() => ({}))) as { preview?: Preview };
        if (res.ok && j.preview) { setPreview(j.preview); setPhase("ready"); return; }
        if (res.status === 400) forgetInviteToken(); // unknown, expired or used: never offered again in this tab
        setErr(res.status === 429 ? J.errors.rate_limited : J.errors.invalid);
      } catch {
        setErr(J.errors.failed);
      }
      setPhase("invalid");
    });
  }, [signedInAs, J]);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    // Hand the token back to the fragment for the reload only; the reloaded page reads it and clears it again.
    const tok = token.current;
    window.history.replaceState(null, "", withoutFragment(window.location) + (tok ? `#t=${tok}` : ""));
    window.location.reload();
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    // The button stays focusable (aria-disabled), so pressing it early says which rules are still unmet (rule 434).
    if (!checks.every(Boolean)) { setErr(unmetRules(checks, J.rules, lang)); pwRef.current?.focus(); return; }
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/team/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.current, name: name.trim(), password: pw, lang }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && j.ok) {
        forgetInviteToken();
        // The route set the session cookie; refreshing re-renders the layout with the app shell of the account just joined.
        r.push(`/${lang}/app`);
        r.refresh();
        return;
      }
      const code = res.status === 429 ? "rate_limited" : (j.error ?? "failed");
      setErr((J.errors as Record<string, string>)[code] ?? J.errors.failed);
      if (code === "invalid") { forgetInviteToken(); setPhase("invalid"); }
    } catch {
      setErr(J.errors.failed);
    }
    setBusy(false);
  }

  const ok = !!name.trim() && checks.every(Boolean);
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="joinform-t1" />{J.title}</span></h1>

      {phase === "checking" && <p role="status" className="page-sub">{J.checking}</p>}

      {phase === "signedIn" && (
        <div className="mt-6 card">
          <p>{parts(J.signedIn, { email: <b dir="ltr">{signedInAs}</b> })}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={logout} disabled={busy} className="btn btn-primary btn-sm">{J.logout}</button>
            <Link href={`/${lang}/app`} className="btn btn-secondary btn-sm">{J.back}</Link>
          </div>
        </div>
      )}

      {(phase === "none" || phase === "invalid") && (
        <>
          <p role="alert" className="mt-6 rounded-lg border border-danger bg-agent-sami/20 p-3 text-sm">{phase === "none" ? J.noToken : err || J.errors.invalid}</p>
          <p className="mt-4 text-sm text-foreground-muted">{J.have} <Link href={`/${lang}/app/login`} className="font-medium text-foreground underline">{J.login}</Link></p>
        </>
      )}

      {phase === "ready" && preview && (
        <>
          <div className="mt-6 card card-sm">
            <p>{parts(J.invited, { inviter: <b dir="auto">{preview.inviter}</b>, team: <b dir="auto">{preview.team}</b>, role: <b>{t.team.roles[preview.role]}</b> })}</p>
            <p className="mt-1 text-xs text-foreground-muted">{t.team.roleHelp[preview.role]}</p>
            <p className="mt-1 text-xs text-foreground-muted">{J.expires} <span className="font-mono" dir="ltr">{preview.expiresAt.slice(0, 10)}</span></p>
          </div>
          <form onSubmit={onSubmit} className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-foreground-muted">{J.email}</span>
              {/* Read-only: the invite fixes the address. Named "username" so a password manager saves the right pair. */}
              <input type="email" name="email" autoComplete="username" value={preview.email} readOnly className="input" dir="ltr" />
            </label>
            <input name="name" required autoFocus autoComplete="name" maxLength={80} dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={J.name} aria-label={J.name} className="input" />
            <PasswordField lang={lang} ref={pwRef} name="password" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={J.password} aria-label={J.password} aria-describedby="join-rules" className="input" />
            <PasswordRules id="join-rules" rules={J.rules} checks={checks} lang={lang} />
            {err && <p role="alert" className="text-sm text-danger">{err}</p>}
            <button disabled={busy} aria-disabled={!ok ? true : undefined} aria-describedby="join-rules" className="s-btn"><Scribble kind="pill" seed="joinform-b1" fill="ink" shadow ring />{busy ? J.joining : J.submit}</button>
          </form>
          <p className="mt-3 text-xs text-foreground-muted">{parts(J.note, { team: <span dir="auto">{preview.team}</span> })}</p>
          <p className="mt-2 text-xs text-foreground-muted">{J.legal1} <Link href={`/${lang}/terms`} className="underline">{J.terms}</Link> {J.and} <Link href={`/${lang}/privacy`} className="underline">{J.privacy}</Link>.</p>
        </>
      )}
    </div>
  );
}
