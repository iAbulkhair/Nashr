"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import { Icon } from "./Icons";

const STR = {
  ar: {
    hello: "أهلاً، أنا نور.", intro: "مسؤولة التسويق في فريقك. أعطني رابطاً واحداً وأبدأ الشغل أمامك.",
    how: "كيف تمشي أول دقائقك",
    steps: [["plug", "تضع الرابط", "موقعك أو متجرك أو حساب إنستقرام."], ["folder", "نور تقرأ وتكتب", "ملف علامتك وملاحظات سوقك وخطة البداية."], ["inbox", "تراجع وتعتمد", "لا شيء يُنشر بدون موافقتك."]] as const,
    path: "مسار الانطلاق", pathSub: "٧ إنجازات من أول رابط إلى علامتك داخل مساعدك الذكي. كل إنجاز يرفع مستواك.",
    levels: [["seed", "بذرة"], ["sapling", "فسيلة"], ["palm", "نخلة"], ["oasis", "واحة"]] as const,
    noSite: "ما عندك موقع؟ ضع رابط حساب إنستقرام أو متجرك في سلة أو زد.",
  },
  en: {
    hello: "Hi, I'm Noor.", intro: "The marketer on your team. Give me one link and I'll start working in front of you.",
    how: "How your first minutes go",
    steps: [["plug", "Paste a link", "Your site, store or Instagram profile."], ["folder", "Noor reads and writes", "Your brand file, market notes and a starter plan."], ["inbox", "You review and approve", "Nothing is published without your approval."]] as const,
    path: "Launch path", pathSub: "7 milestones from your first link to your brand inside your AI assistant. Each one levels you up.",
    levels: [["seed", "Seed"], ["sapling", "Sapling"], ["palm", "Palm"], ["oasis", "Oasis"]] as const,
    noSite: "No website? Paste your Instagram profile or your Salla or Zid store link.",
  },
} as const;

/**
 * The only onboarding question: the website. Submitting opens the "Getting started" thread where Noor builds the
 * workspace live (ChatPanel onboardUrl). Businesses without a site can give an Instagram or store link instead.
 */
export default function StartWizard({ t, lang, initialUrl = "" }: { t: AppDict; lang: Lang; initialUrl?: string }) {
  const r = useRouter();
  const s = t.start;
  const S = STR[lang];
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(initialUrl);
  const ready = url.trim().length >= 4;
  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <section className="card overflow-hidden p-0">
        <div className="sadu-thin" aria-hidden />
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="journey-next pop-in grid h-12 w-12 shrink-0 place-items-center rounded-full bg-oasis font-display text-xl font-bold text-saffron" aria-hidden>{t.agents.noor.name.charAt(0)}</span>
            <div className="min-w-0 rounded-2xl rounded-ss-sm bg-salt-dim px-4 py-2.5 text-sm">
              <p className="font-semibold text-oasis">{S.hello}</p>
              <p className="text-ink/80">{S.intro}</p>
            </div>
          </div>
          <h1 className="page-title mt-5">{s.title}</h1>
          <p className="mt-1 text-ink/70">{s.sub}</p>
          <form
            onSubmit={(e) => { e.preventDefault(); if (!ready) return; setBusy(true); r.push(`/${lang}/app/chat?onboard=${encodeURIComponent(url.trim())}`); }}
            className="mt-5 grid gap-3"
          >
            <label className="relative block">
              <span className="pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-ink/40"><Icon name="plug" className="h-4 w-4" /></span>
              <input name="url" required autoFocus dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={s.url} aria-label={s.url} className="input py-3 ps-9 text-base" />
            </label>
            <button disabled={busy || !ready} className="btn btn-accent btn-lg">{busy ? "…" : <><Icon name="spark" className="h-4 w-4" />{s.go}</>}</button>
            <p className="text-center text-xs text-ink/60">{S.noSite}</p>
            <Link href={`/${lang}/app/onboarding`} className="text-center text-sm text-ink/60 underline">{s.manual}</Link>
          </form>
        </div>
      </section>

      <section aria-label={S.how}>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{S.how}</h2>
        <ol className="mt-2 grid gap-2 sm:grid-cols-3">
          {S.steps.map(([icon, title, body], i) => (
            <li key={title} className="log-row card card-sm flex items-start gap-3 sm:flex-col" style={{ animationDelay: `${i * 120}ms` }}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-oasis/10 text-oasis"><Icon name={icon} className="h-4.5 w-4.5" /></span>
              <span><span className="tnum text-xs text-ink/50" dir="ltr">{i + 1}</span> <span className="font-semibold">{title}</span><span className="block text-xs text-ink/60">{body}</span></span>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-2xl border border-oasis/15 bg-white p-4" aria-label={S.path}>
        <p className="flex items-center gap-2 font-display font-bold text-oasis"><Icon name="trophy" className="h-4 w-4 text-saffron" />{S.path}</p>
        <p className="mt-1 text-xs text-ink/60">{S.pathSub}</p>
        <ol className="mt-3 flex items-center justify-between gap-1">
          {S.levels.map(([icon, name], i) => (
            <li key={icon} className="flex flex-1 items-center gap-1">
              <span className="flex flex-col items-center gap-1">
                <span className={`grid h-10 w-10 place-items-center rounded-full ${i === 0 ? "journey-next bg-oasis text-saffron" : "bg-salt-dim text-ink/40"}`}><Icon name={icon} className="h-5 w-5" /></span>
                <span className={`text-xs ${i === 0 ? "font-semibold text-oasis" : "text-ink/50"}`}>{name}</span>
              </span>
              {i < S.levels.length - 1 && <span aria-hidden className="mb-5 h-0.5 flex-1 rounded-full bg-ink/10" />}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
