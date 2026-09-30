"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import { Icon } from "./Icons";
import { limitFromError, raiseLimit } from "./LimitModal";

const STR = {
  ar: {
    hello: "أهلاً، أنا نور.", intro: "مسؤولة التسويق في فريقك. أعطني رابطاً واحداً وأبدأ الشغل أمامك.",
    how: "كيف تمشي أول دقائقك",
    steps: [["plug", "تضع الرابط", "موقعك أو متجرك أو حساب إنستقرام."], ["folder", "نور تقرأ وتكتب", "ملف علامتك وملاحظات سوقك وخطة البداية."], ["inbox", "تراجع وتعتمد", "لا شيء يُنشر بدون موافقتك."]] as const,
    path: "مسار الانطلاق", pathSub: "٧ إنجازات من أول رابط إلى علامتك داخل مساعدك الذكي. كل إنجاز يرفع مستواك.",
    levels: [["seed", "بذرة"], ["sapling", "فسيلة"], ["palm", "نخلة"], ["oasis", "واحة"]] as const,
    noSite: "ما عندك موقع؟ ضع رابط حساب إنستقرام أو متجرك في سلة أو زد.",
    review: "راجع الرابط قبل أن تبدأ نور: ستقرأ هذا الموقع وتبني منه ملف علامتك. تأكد أنه موقعك، أو غيّره.",
  },
  en: {
    hello: "Hi, I'm Noor.", intro: "The marketer on your team. Give me one link and I'll start working in front of you.",
    how: "How your first minutes go",
    steps: [["plug", "Paste a link", "Your site, store or Instagram profile."], ["folder", "Noor reads and writes", "Your brand file, market notes and a starter plan."], ["inbox", "You review and approve", "Nothing is published without your approval."]] as const,
    path: "Launch path", pathSub: "7 milestones from your first link to your brand inside your AI assistant. Each one levels you up.",
    levels: [["seed", "Seed"], ["sapling", "Sapling"], ["palm", "Palm"], ["oasis", "Oasis"]] as const,
    noSite: "No website? Paste your Instagram profile or your Salla or Zid store link.",
    review: "Check this link before Noor starts: she reads this site and builds your brand file from it. Make sure it is yours, or change it.",
  },
} as const;

/**
 * The only onboarding question: the website. Submitting records the owner's confirmation (POST /api/onboard/confirm)
 * and opens the "Getting started" thread where Noor builds the workspace live (ChatPanel onboardUrl). A URL carried in
 * from a link (signup `?url=`, chat `?onboard=`) only pre-fills the field: nothing is read until the owner presses Go.
 * Businesses without a site can give an Instagram or store link instead.
 *
 * `setupCost` (from `onboardCost(u.brandId)` on the server): 0 for the first brand; an added brand's setup costs credits,
 * stated here with the balance before Go, and Go is off when the balance cannot cover it. `setupPaid`: a charge for this
 * brand is already held (a run that did not finish), so the balance is not asked again and Go stays on, as on the server.
 * The server checks the same rule (402 from confirm) and charges only when the build starts, refunding a build that
 * could not save the brand file.
 */
export default function StartWizard({ t, lang, initialUrl = "", setupCost = 0, setupPaid = false, credits = 0 }: { t: AppDict; lang: Lang; initialUrl?: string; setupCost?: number; setupPaid?: boolean; credits?: number }) {
  const r = useRouter();
  const s = t.start;
  const S = STR[lang];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState(initialUrl);
  const short = setupCost > 0 && !setupPaid && credits < setupCost;
  const ready = url.trim().length >= 4 && !short;
  const fill = (text: string, n: number, have: number) => text.replace("{n}", String(n)).replace("{credits}", String(have));
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setErr("");
    const site = url.trim().slice(0, 300);
    const res = await fetch("/api/onboard/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: site }) }).catch(() => null);
    // 409: this workspace already has a brand, so the chat opens as usual and onboarding does not run again.
    if (res && (res.ok || res.status === 409)) { r.push(`/${lang}/app/chat?onboard=${encodeURIComponent(site)}`); return; }
    setBusy(false);
    // 402: an added brand's setup the balance cannot cover, or a trial that ended. Nothing was charged.
    if (res?.status === 402) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; need?: number; credits?: number };
      limitFromError(j.error);
      setErr(j.error === "no_credits" ? fill(s.noCredits, j.need ?? setupCost, j.credits ?? credits) : j.error === "trial_over" ? t.generate.trialOver : s.notCharged);
      return;
    }
    setErr(s.steps.error);
  }
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
          <form onSubmit={onSubmit} className="mt-5 grid gap-3">
            {initialUrl && <p role="note" className="rounded-lg border border-saffron/40 bg-saffron/10 px-3 py-2 text-sm text-ink/80">{S.review}</p>}
            <label className="relative block">
              <span className="pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-ink/40"><Icon name="plug" className="h-4 w-4" /></span>
              <input name="url" required autoFocus dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={s.url} aria-label={s.url} className="input py-3 ps-9 text-base" />
            </label>
            {setupCost > 0 ? (
              <p role="note" className="rounded-lg border border-saffron/40 bg-saffron/10 px-3 py-2 text-sm text-ink/80">
                {setupPaid ? fill(s.setupPaid, setupCost, credits) : short ? fill(s.noCredits, setupCost, credits) : fill(s.setupCost, setupCost, credits)}
                {short && <> <button type="button" onClick={() => raiseLimit("credits")} className="underline">{t.limit.plans}</button></>}
              </p>
            ) : (
              <p className="text-xs text-ink/60">{s.setupFree}</p>
            )}
            {err && <p role="alert" className="text-sm text-sadu-deep">{err}</p>}
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
