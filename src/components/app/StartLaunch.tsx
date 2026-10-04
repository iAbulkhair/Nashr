"use client";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import { START_COPY, noSiteBrand, type GameAnswers } from "@/lib/dictionary";
import { Icon } from "./Icons";
import { limitFromError, raiseLimit } from "./LimitModal";

const STR = {
  ar: {
    choice: "من وين تبدأ نور؟",
    linkHint: "موقعك، أو حساب إنستقرام، أو متجرك في سلة أو زد.",
    review: "راجع الرابط قبل أن تبدأ نور: ستقرأ هذا الموقع وتبني منه ملف علامتك. تأكد أنه موقعك، أو غيّره.",
  },
  en: {
    choice: "Where should Noor start?",
    linkHint: "Your site, your Instagram profile, or your Salla or Zid store.",
    review: "Check this link before Noor starts: she reads this site and builds your brand file from it. Make sure it is yours, or change it.",
  },
} as const;

/**
 * The first-login game's last step (src/components/app/DictionaryStart.tsx): the owner either gives a link or says they
 * have no website. Nothing is saved before this step.
 *
 * With a link, Go records the owner's confirmation with their answers (POST /api/onboard/confirm {url, answers}) and opens
 * the "Getting started" thread where Noor builds the workspace live from that site, keeping the owner's name, sector and
 * voice (rules 522-523). A URL carried in from a link (signup `?url=`, chat `?onboard=`) only pre-fills the field: nothing
 * is read until the owner presses Go. Without a site, the answers plus what they sell and who buys become the brand file
 * through PUT /api/brand (auth, `brand.write`, the caller's scope, required fields), and the workspace opens (rule 526).
 *
 * `setupCost` (from `onboardCost(u.brandId)` on the server): 0 for the first brand; an added brand's setup costs credits,
 * stated here with the balance before Go, and Go is off when the balance cannot cover it. `setupPaid`: a charge for this
 * brand is already held (a run that did not finish), so the balance is not asked again and Go stays on, as on the server.
 * The server checks the same rule (402 from confirm) and charges only when the build starts, refunding a build that
 * could not save the brand file.
 */
export default function StartLaunch({ t, lang, answers, initialUrl = "", setupCost = 0, setupPaid = false, credits = 0 }: { t: AppDict; lang: Lang; answers: GameAnswers; initialUrl?: string; setupCost?: number; setupPaid?: boolean; credits?: number }) {
  const r = useRouter();
  const s = t.start;
  const S = STR[lang];
  const hint = useId();
  const [mode, setMode] = useState<"site" | "none">("site");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState(initialUrl);
  const [products, setProducts] = useState("");
  const [audience, setAudience] = useState("");
  const short = setupCost > 0 && !setupPaid && credits < setupCost;
  const ready = url.trim().length >= 4 && !short;
  const readyNoSite = products.trim() !== "" && audience.trim() !== "";
  const fill = (text: string, n: number, have: number) => text.replace("{n}", String(n)).replace("{credits}", String(have));
  const pick = (m: "site" | "none") => { setMode(m); setErr(""); };

  async function onSite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setErr("");
    const site = url.trim().slice(0, 300);
    const res = await fetch("/api/onboard/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: site, answers }) }).catch(() => null);
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

  async function onNoSite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!readyNoSite || busy) return;
    setBusy(true); setErr("");
    const res = await fetch("/api/brand", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noSiteBrand(answers, products, audience)) }).catch(() => null);
    // 409: a brand was built meanwhile (another tab); the save is create-only, so the workspace opens with that brand.
    if (res && (res.ok || res.status === 409)) { r.push(`/${lang}/app`); r.refresh(); return; }
    setBusy(false);
    setErr(s.steps.error);
  }

  const tab = (m: "site" | "none") => `btn ${mode === m ? "btn-primary" : "btn-secondary"}`;
  return (
    <div className="grid gap-4">
      <div role="group" aria-label={S.choice} className="grid grid-cols-2 gap-2">
        <button type="button" aria-pressed={mode === "site"} onClick={() => pick("site")} className={tab("site")}><Icon name="plug" className="h-4 w-4" />{START_COPY.haveSite[lang]}</button>
        <button type="button" aria-pressed={mode === "none"} onClick={() => pick("none")} className={tab("none")}>{START_COPY.noSite[lang]}</button>
      </div>

      {mode === "site" ? (
        <form onSubmit={onSite} className="grid gap-3">
          {initialUrl && <p role="note" className="rounded-lg border border-lemon/40 bg-lemon/10 px-3 py-2 text-sm text-ink/80">{S.review}</p>}
          <label className="relative block">
            <span className="pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-ink/40"><Icon name="plug" className="h-4 w-4" /></span>
            <input name="url" required dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={s.url} aria-label={s.url} aria-describedby={hint} className="input py-3 ps-9 text-base" />
          </label>
          <p id={hint} className="text-xs text-ink/60">{S.linkHint}</p>
          {setupCost > 0 ? (
            <p role="note" className="rounded-lg border border-lemon/40 bg-lemon/10 px-3 py-2 text-sm text-ink/80">
              {setupPaid ? fill(s.setupPaid, setupCost, credits) : short ? fill(s.noCredits, setupCost, credits) : fill(s.setupCost, setupCost, credits)}
              {short && <> <button type="button" onClick={() => raiseLimit("credits")} className="underline">{t.limit.plans}</button></>}
            </p>
          ) : (
            <p className="text-xs text-ink/60">{s.setupFree}</p>
          )}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <button disabled={busy || !ready} className="btn btn-accent btn-lg">{busy ? "…" : <><Icon name="spark" className="h-4 w-4" />{s.go}</>}</button>
        </form>
      ) : (
        <form onSubmit={onNoSite} className="grid gap-3">
          <label className="grid gap-1 text-sm font-semibold">
            {START_COPY.products[lang]}
            <input name="products" required maxLength={1000} dir="auto" value={products} onChange={(e) => setProducts(e.target.value)} className="input py-2.5 text-base font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            {START_COPY.audience[lang]}
            <input name="audience" required maxLength={1000} dir="auto" value={audience} onChange={(e) => setAudience(e.target.value)} className="input py-2.5 text-base font-normal" />
          </label>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <button disabled={busy || !readyNoSite} className="btn btn-primary btn-lg">{busy ? "…" : START_COPY.saveNoSite[lang]}</button>
        </form>
      )}
    </div>
  );
}
