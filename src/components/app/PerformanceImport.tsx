"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { fmt, int, METRICS, type Finding, type MetricId, type PerfSnapshot } from "@/lib/perf-import";
import { Icon } from "./Icons";
import ReadOnlyNote from "./ReadOnlyNote";

const STR = {
  ar: {
    live: "مباشر", syncFrom: (p: string) => `اقرأ النتائج من ${p}`, liveNote: "آخر 30 يوماً من حسابك الإعلاني، قراءة فقط. تتحدّث تلقائياً كل يوم.", orUpload: "أو ارفع ملف CSV",
    adErrors: { reconnect_required: "انتهت صلاحية الربط. أعد ربط الحساب من صفحة التكاملات.", no_ad_results: "لا نتائج إعلانات في آخر 30 يوماً في هذا الحساب.", no_ad_account: "لم نجد حساباً إعلانياً نشطاً في هذا الربط.", slow_down: "تحديثات كثيرة. حاول بعد ساعة." } as Record<string, string>,
    nashrTitle: "إعلانات ذكين", nashrNone: "لم نجد بعد إعلاناً يحمل كوداً من ذكين. انسخ الكود (NSR-…) من بطاقة الإعلان في صندوق الموافقة وضعه في اسم الإعلان في مدير الإعلانات.", nashrFew: "وجدنا إعلانات ذكين، لكن العيّنة لا تكفي بعد للمقارنة مع بقية إعلاناتك.", tooSmall: "عيّنة صغيرة",
    title: "نتائج حملاتك (CSV)", sub: "صدّر تقرير الإعلانات من Meta أو سناب شات أو تيك توك أو Google Ads وارفعه هنا. نور تستخرج ما نجح وتبني عليه خطتك القادمة. بدون رصيد.",
    how: "كيف أصدّر التقرير؟", howBody: "من مدير الإعلانات افتح التقارير على مستوى الإعلان، وأضف أعمدة الظهور والنقرات والمبلغ المنفق والنتائج (أو قيمة الشراء)، ثم صدّر بصيغة CSV.",
    drop: "اسحب ملف CSV هنا أو اضغط للاختيار", reading: "نور تقرأ النتائج…", replace: "ارفع ملفاً أحدث", remove: "احذف الاستيراد", removeFail: "لم يُحذف الاستيراد. حاول مرة أخرى.", readOnly: "استيراد نتائج الحملات من ملف أو حذفها لمالك الحساب أو المدير. النتائج هنا للقراءة.",
    rows: "إعلانات في الملف", ranked: "بيانات كافية للترتيب", overall: "المتوسط العام", spend: "الإنفاق",
    winners: "الأفضل أداءً", weakest: "الأضعف", patterns: "أنماط لاحظتها نور", waste: "إنفاق بلا نتيجة",
    medium: "يستحق التنفيذ", low: "فكرة للتجربة", sample: "العيّنة", metric: "المقياس",
    saved: "حُفظت في performance-learnings.md، وتقرؤها نور في كل توليد.", honest: "مقارنة بين إعلاناتك أنت، وليست إثباتاً للسبب. الأنماط منخفضة الثقة أفكار تُجرَّب.",
    variants: "اطلب من نور 5 بدائل للفائزين", plan: "خطط الأسبوع القادم بهذه النتائج", excluded: (n: number) => `${n} استُبعدت لأن عيّنتها صغيرة`,
    errors: { no_columns: "لم أجد أعمدة أعرفها في الملف. تأكد أنه تقرير إعلانات بصيغة CSV.", no_name_column: "الملف بلا عمود لاسم الإعلان أو الحملة.", no_metrics: "الملف بلا أرقام أداء كافية (ظهور ونقرات، أو إنفاق ونتائج).", no_rows: "الملف لا يحتوي صفوف إعلانات.", too_large: "الملف أكبر من 2 ميغابايت. صدّر فترة أقصر.", slow_down: "استوردت ملفات كثيرة خلال ساعة. حاول لاحقاً.", read: "تعذّرت قراءة الملف.", generic: "تعذّر الاستيراد. حاول مرة أخرى." } as Record<string, string>,
    variantsPrompt: "اقرأ performance-learnings.md واكتب 5 بدائل جديدة مبنية على زاوية وأسلوب الإعلانات الأفضل أداءً، واذكر أي نمط اعتمدت عليه وحجم عيّنته.",
    planPrompt: "اقرأ performance-learnings.md واكتب خطة الأسبوع القادم مبنية على ما نجح، واقترح ما نوقفه أو نعيد كتابته.",
  },
  en: {
    live: "Live", syncFrom: (p: string) => `Read results from ${p}`, liveNote: "The last 30 days from your ad account, read only. Refreshed automatically every day.", orUpload: "or upload a CSV",
    adErrors: { reconnect_required: "The connection expired. Reconnect the account on the Integrations page.", no_ad_results: "No ad results in the last 30 days in this account.", no_ad_account: "No active ad account was found on this connection.", slow_down: "Too many refreshes. Try again in an hour." } as Record<string, string>,
    nashrTitle: "Thakeen's ads", nashrNone: "No ad with a Thakeen code yet. Copy the code (NSR-…) from an ad card in the approval inbox into the ad's name in your ads manager.", nashrFew: "Thakeen's ads are in, but there is not enough data yet to compare them with your other ads.", tooSmall: "small sample",
    title: "Campaign results (CSV)", sub: "Export an ads report from Meta, Snapchat, TikTok or Google Ads and drop it here. Noor pulls out what worked and builds your next plan on it. No credits.",
    how: "How do I export it?", howBody: "In your ads manager, open reporting at the ad level, add impressions, clicks, amount spent and results (or purchase value) columns, then export as CSV.",
    drop: "Drop a CSV here or click to choose", reading: "Noor is reading the results…", replace: "Upload a newer file", remove: "Remove import", removeFail: "The import was not removed. Try again.", readOnly: "Importing campaign results from a file, or removing them, is for the account owner or an admin. The findings are here to read.",
    rows: "Ads in the file", ranked: "Enough data to rank", overall: "Overall", spend: "Spend",
    winners: "Best performers", weakest: "Weakest", patterns: "Patterns Noor found", waste: "Spend with no result",
    medium: "Worth acting on", low: "Idea to test", sample: "sample", metric: "Metric",
    saved: "Saved as performance-learnings.md; Noor reads it on every generation.", honest: "A comparison of your own ads, not proof of cause. Low-confidence patterns are ideas to test.",
    variants: "Ask Noor for 5 variants of the winners", plan: "Plan next week on these results", excluded: (n: number) => `${n} left out as too small to judge`,
    errors: { no_columns: "I couldn't find columns I recognise. Make sure it's an ads report exported as CSV.", no_name_column: "The file has no ad or campaign name column.", no_metrics: "The file doesn't have enough performance numbers (impressions and clicks, or spend and results).", no_rows: "The file has no ad rows.", too_large: "The file is over 2 MB. Export a shorter period.", slow_down: "Too many imports in the last hour. Try again later.", read: "The file could not be read.", generic: "The import failed. Try again." } as Record<string, string>,
    variantsPrompt: "Read performance-learnings.md and write 5 new variants built on the angle and wording of the best-performing ads. Say which pattern each one relies on and its sample size.",
    planPrompt: "Read performance-learnings.md and write next week's plan built on what worked, and propose what to pause or rewrite.",
  },
} as const;

const MEDAL = ["bg-lemon text-accent-foreground", "bg-background-muted/75 text-foreground", "bg-agent-sami/20 text-danger"];

const AD_NAMES: Record<string, string> = { meta_ads: "Meta Ads", snapchat: "Snapchat Ads", google_ads: "Google Ads", tiktok_ads: "TikTok Ads", linkedin_ads: "LinkedIn Ads" };

/**
 * `canImport` / `canDelete` come from `can()` on the server ("performance.import", "performance.delete": admin and
 * owner). Without them the upload and the remove button are not offered; the route refuses them regardless.
 */
export default function PerformanceImport({ lang, initial, ads = [], canImport = true, canDelete = true }: { lang: "ar" | "en"; initial: PerfSnapshot | null; /** connected ad accounts it can read from */ ads?: string[]; canImport?: boolean; canDelete?: boolean }) {
  const S = STR[lang];
  const r = useRouter();
  const [snap, setSnap] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [fresh, setFresh] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // The last file uploaded in this visit, kept so the metric can be switched without choosing the file again.
  const [last, setLast] = useState<{ csv: string; file: string } | null>(null);

  async function send(csv: string, file: string, metric?: MetricId) {
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/performance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv, file, metric }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; snapshot?: PerfSnapshot; error?: string };
      if (!res.ok || !j.snapshot) { setErr(S.errors[j.error ?? ""] ?? S.errors.generic); return; }
      setLast({ csv, file });
      setSnap(j.snapshot); setFresh(true);
      r.refresh();
    } catch { setErr(S.errors.generic); } finally { setBusy(false); }
  }
  async function pick(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) { setErr(S.errors.too_large); return; }
    try { await send(await f.text(), f.name); } catch { setErr(S.errors.read); }
  }
  async function sync(provider: string) {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/connect/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync_ads" }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; snapshot?: PerfSnapshot; error?: string };
      if (!res.ok || !j.snapshot) { setErr(S.adErrors[j.error ?? ""] ?? S.errors.generic); return; }
      setLast(null); setSnap(j.snapshot); setFresh(true);
      r.refresh();
    } catch { setErr(S.errors.generic); } finally { setBusy(false); }
  }
  async function remove() {
    setErr("");
    // Cleared only once the server said so: a refused or failed delete must not look like one that happened.
    const res = await fetch("/api/performance", { method: "DELETE" }).catch(() => null);
    if (!res?.ok) { setErr(S.removeFail); return; }
    setSnap(null); setLast(null); r.refresh();
  }

  const m = snap ? METRICS[snap.metric] : null;
  // Metrics the file can support, from the totals it reported; switching re-ranks the same file.
  const fits = snap ? (Object.keys(METRICS) as MetricId[]).filter((id) => { const d = METRICS[id]; return id === "cpa" ? !!snap.totals.spend && !!snap.totals.conversions : !!snap.totals[d.num] && !!snap.totals[d.den]; }) : [];
  const by = (k: Finding["kind"]) => snap?.findings.filter((f) => f.kind === k) ?? [];
  const chat = (p: string) => `/${lang}/app/chat?prompt=${encodeURIComponent(p)}`;

  return (
    <section id="campaign-results" className="card mt-6 overflow-hidden p-0" aria-label={S.title}>
      <header className="flex flex-wrap items-start gap-3 border-b border-foreground/5 px-5 py-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-inverse text-lemon"><Icon name="chart" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xl font-bold">{S.title}</h2>
          <p className="mt-0.5 text-sm text-foreground-muted">{S.sub}</p>
          <details className="mt-1 text-xs text-foreground-muted"><summary className="underline">{S.how}</summary><p className="mt-1">{S.howBody}</p></details>
        </div>
        {snap && canDelete && <button onClick={remove} className="btn btn-secondary btn-xs">{S.remove}</button>}
      </header>

      <div className="px-5 py-4">
        {ads.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {ads.map((p) => <button key={p} disabled={busy} onClick={() => sync(p)} className="btn btn-primary btn-xs"><Icon name="chart" className="h-3.5 w-3.5" />{S.syncFrom(AD_NAMES[p] ?? p)}</button>)}
            <span className="text-xs text-foreground-muted">{S.orUpload}</span>
          </div>
        )}
        {!canImport && <ReadOnlyNote className="" text={S.readOnly} />}
        {canImport && <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void pick(e.dataTransfer.files[0]); }}
          className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 ${snap ? "py-3 text-sm" : "py-8"} text-center transition-colors ${drag ? "border-border-strong bg-background-muted" : "border-border hover:border-border-strong hover:bg-background"}`}
        >
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          {busy ? <><span className="h-2 w-2 animate-pulse rounded-full bg-lemon" />{S.reading}</> : <><Icon name="plus" className="h-4 w-4 text-foreground" /><span className="font-semibold text-foreground">{snap ? S.replace : S.drop}</span></>}
        </label>}
        {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}

        {snap && m && (
          <div className={fresh ? "log-row" : ""}>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
              {snap.source && snap.source !== "csv" && <span className="flex items-center gap-1 rounded-full bg-inverse px-2 py-0.5 font-semibold text-inverse-muted"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lemon" />{S.live}</span>}
              <span className="badge badge-primary">{snap.platform}</span>
              <span dir="ltr">{snap.file}</span>
              {snap.range && <span dir="ltr">{snap.range.from} → {snap.range.to}</span>}
              {fits.length > 1 && last && canImport && (
                <label className="ms-auto flex items-center gap-1">{S.metric}
                  <select value={snap.metric} disabled={busy} onChange={(e) => send(last.csv, last.file, e.target.value as MetricId)} className="rounded border border-border bg-surface px-2 py-1">
                    {fits.map((id) => <option key={id} value={id}>{METRICS[id].label[lang]}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[[S.rows, String(snap.rows)], [S.ranked, String(snap.ranked)], [`${S.overall} · ${m.label[lang]}`, snap.overall != null ? fmt(snap.metric, snap.overall, lang) : "—"], [S.spend, snap.totals.spend != null ? int(snap.totals.spend) : "—"]].map(([l, v]) => (
                <div key={l} className="rounded-lg bg-background-muted p-3"><p className="text-xs text-foreground-muted">{l}</p><p className="tnum font-display text-xl font-bold text-foreground" dir="ltr">{v}</p></div>
              ))}
            </div>
            {snap.excluded > 0 && <p className="mt-1 text-xs text-foreground-muted">{S.excluded(snap.excluded)}</p>}
            {snap.source && snap.source !== "csv" && <p className="mt-1 text-xs text-foreground-muted">{S.liveNote}</p>}

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><Icon name="trophy" className="h-4 w-4 text-foreground" />{S.winners}</h3>
                <ol className="mt-2 grid gap-1.5">
                  {snap.top.map((w, i) => (
                    <li key={w.name + i} className="pop-in flex items-center gap-2 rounded-lg border border-foreground/10 bg-surface px-3 py-2 text-sm" style={{ animationDelay: `${i * 90}ms` }}>
                      <span className={`tnum grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${MEDAL[i]}`}>{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate" dir="auto" title={w.name}>{w.name}</span>
                      <span className="tnum shrink-0 font-semibold text-foreground" dir="ltr">{fmt(snap.metric, w.value, lang)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              {snap.bottom.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-danger">{S.weakest}</h3>
                  <ol className="mt-2 grid gap-1.5">
                    {snap.bottom.map((w, i) => (
                      <li key={w.name + i} className="flex items-center gap-2 rounded-lg border border-danger bg-agent-sami/20 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate" dir="auto" title={w.name}>{w.name}</span>
                        <span className="tnum shrink-0 font-semibold text-danger" dir="ltr">{fmt(snap.metric, w.value, lang)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>

            {[...by("spread"), ...by("pattern"), ...by("group"), ...by("dead_spend")].length > 0 && (
              <div className="mt-4">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><Icon name="spark" className="h-4 w-4 text-foreground" />{S.patterns}</h3>
                <ul className="mt-2 grid gap-1.5">
                  {[...by("spread"), ...by("pattern"), ...by("group"), ...by("dead_spend")].map((f, i) => (
                    <li key={i} className={`flex flex-wrap items-start gap-2 rounded-lg px-3 py-2 text-sm ${f.kind === "dead_spend" ? "border border-danger bg-agent-sami/20" : "bg-background"}`}>
                      <span className="min-w-0 flex-1" dir="auto">{f.kind === "dead_spend" && <span className="font-semibold text-danger">{S.waste}: </span>}{f.text[lang]}</span>
                      <span className={`badge shrink-0 ${f.confidence === "medium" ? "badge-primary" : "badge-accent"}`}>{f.confidence === "medium" ? S.medium : S.low}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 rounded-xl border border-border bg-foreground/5 p-3">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><Icon name="seed" className="h-4 w-4" />{S.nashrTitle}</h3>
              {!snap.nashr ? <p className="mt-1 text-xs text-foreground-muted">{S.nashrNone}</p> : (
                <>
                  {snap.nashr.text ? (
                    <p className="mt-1 flex flex-wrap items-start gap-2 text-sm"><span className="min-w-0 flex-1" dir="auto">{snap.nashr.text[lang]}</span><span className={`badge shrink-0 ${snap.nashr.confidence === "medium" ? "badge-primary" : "badge-accent"}`}>{snap.nashr.confidence === "medium" ? S.medium : S.low}</span></p>
                  ) : <p className="mt-1 text-xs text-foreground-muted">{S.nashrFew}</p>}
                  <ul className="mt-2 grid gap-1">
                    {snap.nashr.ads.map((a) => (
                      <li key={a.code + a.name} className="flex items-center gap-2 rounded-lg bg-surface px-3 py-1.5 text-xs">
                        <span className="font-mono font-semibold text-foreground" dir="ltr">{a.code}</span>
                        <span className="min-w-0 flex-1 truncate" dir="auto" title={a.name}>{a.name}</span>
                        <span className="tnum shrink-0 font-semibold" dir="ltr">{a.value == null ? S.tooSmall : fmt(snap.metric, a.value, lang)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <p className="mt-3 text-xs text-foreground-muted">{S.honest}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-foreground/5 pt-3">
              <Link href={chat(S.variantsPrompt)} className="btn btn-accent btn-xs"><Icon name="spark" className="h-3.5 w-3.5" />{S.variants}</Link>
              <Link href={chat(S.planPrompt)} className="btn btn-secondary btn-xs"><Icon name="calendar" className="h-3.5 w-3.5" />{S.plan}</Link>
              <span className="ms-auto flex items-center gap-1 text-xs text-foreground"><Icon name="check" className="h-3.5 w-3.5" />{S.saved}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
