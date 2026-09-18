"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";

/**
 * The only onboarding question: the website. Submitting opens the "Getting
 * started" thread where Noor builds the workspace live (ChatPanel onboardUrl).
 * Businesses without a site can give an Instagram or store link instead.
 */
export default function StartWizard({ t, lang, initialUrl = "" }: { t: AppDict; lang: Lang; initialUrl?: string }) {
  const r = useRouter();
  const s = t.start;
  const [busy, setBusy] = useState(false);
  const ar = lang === "ar";
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="page-title">{s.title}</h1>
      <p className="mt-2 text-ink/70">{s.sub}</p>
      <form
        onSubmit={(e) => { e.preventDefault(); const url = String(new FormData(e.currentTarget).get("url") ?? "").trim(); if (url.length < 4) return; setBusy(true); r.push(`/${lang}/app/chat?onboard=${encodeURIComponent(url)}`); }}
        className="mt-6 grid gap-3"
      >
        <input name="url" required autoFocus dir="ltr" defaultValue={initialUrl} placeholder={s.url} aria-label={s.url} className="input" />
        <button disabled={busy} className="btn btn-primary">{busy ? "…" : s.go}</button>
        <p className="text-center text-xs text-ink/60">{ar ? "ما عندك موقع؟ ضع رابط حساب إنستقرام أو متجرك في سلة أو زد." : "No website? Paste your Instagram profile or your Salla or Zid store link."}</p>
        <Link href={`/${lang}/app/onboarding`} className="text-center text-sm text-ink/60 underline">{s.manual}</Link>
      </form>
    </div>
  );
}
