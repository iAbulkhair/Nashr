"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";

const input = "input";

export function SignupForm({ t, lang }: { t: AppDict; lang: Lang }) {
  const r = useRouter();
  const sp = useSearchParams();
  const ref = sp.get("ref") ?? "";
  const nextParam = sp.get("next") ?? "";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "";
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, lang, ref }) });
    const j = await res.json();
    setBusy(false);
    if (!j.ok) return setErr((t.signup as Record<string, string>)[j.error] ?? j.error);
    if (next) { window.location.assign(next); return; }
    r.push(`/${lang}/app/start`);
    r.refresh();
  }
  return (
    <div className="mx-auto max-w-md">
      <h1 className="page-title">{t.signup.title}</h1>
      <p className="mt-2 text-ink/70">{t.signup.sub}</p>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <input name="name" required placeholder={t.signup.name} className={input} />
        <input name="phone" required type="tel" inputMode="tel" dir="ltr" placeholder="+9665xxxxxxxx" aria-label={t.signup.phone} className={input} />
        <input name="email" required type="email" dir="ltr" placeholder={t.signup.email} className={input} />
        <input name="password" required type="password" minLength={8} placeholder={t.signup.password} className={input} />
        {err && <p role="alert" className="text-sm text-sadu">{err}</p>}
        <button disabled={busy} className="btn btn-primary">{t.signup.submit}</button>
      </form>
      <p className="mt-4 text-sm text-ink/70">
        {t.signup.have} <Link href={`/${lang}/app/login`} className="font-medium text-oasis underline">{t.signup.login}</Link>
      </p>
    </div>
  );
}

export function LoginForm({ t, lang }: { t: AppDict; lang: Lang }) {
  const r = useRouter();
  const nextParam = useSearchParams().get("next") ?? "";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "";
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    setBusy(false);
    if (!res.ok) { const j = await res.json().catch(() => ({} as { error?: string })); return setErr(j.error === "suspended" ? t.login.suspended : t.login.invalid); }
    if (next) { window.location.href = next; return; }
    r.push(`/${lang}/app`);
    r.refresh();
  }
  return (
    <div className="mx-auto max-w-md">
      <h1 className="page-title">{t.login.title}</h1>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <input name="email" required type="email" dir="ltr" placeholder={t.login.email} className={input} />
        <input name="password" required type="password" placeholder={t.login.password} className={input} />
        {err && <p role="alert" className="text-sm text-sadu">{err}</p>}
        <button disabled={busy} className="btn btn-primary">{t.login.submit}</button>
      </form>
      <p className="mt-4 text-sm text-ink/70">
        {t.login.noAccount} <Link href={`/${lang}/app/signup`} className="font-medium text-oasis underline">{t.login.signup}</Link>
      </p>
    </div>
  );
}
