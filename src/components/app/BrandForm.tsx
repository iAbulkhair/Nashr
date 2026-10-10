"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Brand } from "@/lib/brand";
import type { Lang } from "@/lib/i18n";
import { bannedTerms } from "@/lib/brand-rules";
import { ZONES, ZONE_IDS, zoneOf, zoneUtcLabel } from "@/lib/zones";
import { Icon } from "./Icons";
import ReadOnlyNote from "./ReadOnlyNote";
import { BrandModelField } from "./ModelPicker";
import Scribble from "@/components/Scribble";

const GUARD = {
  ar: { title: "حارس العلامة", body: "كلمات لا تريدها في أي منشور. أي مسودة تحتوي واحدة منها لا تُعتمد ولا تُنشر حتى تعدّلها. التحقق في الكود، وليس وعداً من النموذج.", examples: "أمثلة شائعة، اضغط للإضافة:", count: (n: number) => `${n} كلمة محمية`, none: "لا كلمات بعد: الحارس متوقف.", ex: ["مضمون", "الأفضل", "رقم 1", "رخيص", "بدون ألم"] },
  en: { title: "Brand guard", body: "Words you never want in a post. A draft that contains one cannot be approved or published until you edit it. Checked in code, not promised by the model.", examples: "Common examples, tap to add:", count: (n: number) => `${n} protected ${n === 1 ? "word" : "words"}`, none: "No words yet: the guard is off.", ex: ["guaranteed", "#1", "cheapest", "best in Saudi", "risk-free"] },
} as const;

/** Why a save failed (rule 975), by the code PUT /api/brand answers; anything else is the generic line. */
export const BRAND_SAVE_ERRORS = {
  ar: { missing: "املأ الاسم والمجال والمنتجات والجمهور ثم احفظ.", busy: "حفظ آخر للعلامة يجري الآن. انتظر لحظة ثم احفظ مرة أخرى.", forbidden: "تعديل ملف العلامة للمالك والمسؤول فقط.", failed: "لم يُحفظ شيء. حاول مرة أخرى." },
  en: { missing: "Fill in the name, industry, products and audience, then save.", busy: "Another save of this brand is running. Wait a moment, then save again.", forbidden: "Only the owner and admins can edit the brand file.", failed: "Nothing was saved. Try again." },
} as const;
export function brandSaveError(lang: Lang, status: number, code?: string): string {
  const E = BRAND_SAVE_ERRORS[lang];
  if (code === "missing") return E.missing;
  if (code === "busy") return E.busy;
  if (status === 403) return E.forbidden;
  return E.failed;
}

const input = "input";
const CHANNELS = ["instagram", "snapchat", "tiktok", "x", "linkedin", "whatsapp", "google"];

/**
 * `readOnly` (plain members): every field disabled by the wrapping fieldset, no Save, and a note. PUT /api/brand refuses them in code.
 * Under the form, once the brand file exists, its "Default model for content" (`BrandModelField`), with its own Save:
 * PUT /api/brand never changes the pick. `canConfirmChina`: the owner, not a founder impersonating.
 */
export default function BrandForm({ t, lang, initial, readOnly = false, canConfirmChina = false }: { t: AppDict; lang: Lang; initial: Brand | null; readOnly?: boolean; canConfirmChina?: boolean }) {
  const r = useRouter();
  const o = t.onboarding;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [langs, setLangs] = useState<string[]>(initial?.languages ?? [lang === "en" ? "en" : "ar"]);
  const [channels, setChannels] = useState<string[]>(initial?.channels ?? ["instagram", "snapchat", "tiktok", "whatsapp"]);
  const [banned, setBanned] = useState(initial?.banned ?? "");
  const G = GUARD[lang];
  const terms = bannedTerms(banned);
  const addTerm = (w: string) => setBanned((b) => (bannedTerms(b).some((x) => x.toLowerCase() === w.toLowerCase()) ? b : [b.trim(), w].filter(Boolean).join(lang === "ar" ? "، " : ", ")));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (readOnly) return;
    setBusy(true);
    setMsg("");
    setErr("");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/brand", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, languages: langs, channels }) }).catch(() => null);
    setBusy(false);
    // A refusal says why and keeps what was typed (rule 975): before, a failed save showed nothing at all. A save of a
    // brand that exists stays on this page with "Saved"; only the first save (no brand file yet) goes on to the chat.
    if (!res?.ok) {
      const j = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setErr(brandSaveError(lang, res?.status ?? 0, j.error));
      return;
    }
    setMsg(o.saved);
    if (initial) r.refresh();
    else { r.push(`/${lang}/app/chat`); r.refresh(); }
  }
  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="brandform-t1" />{o.title}</span></h1>
      <p className="mt-2 text-ink/70">{o.sub}</p>
      {readOnly && <ReadOnlyNote text={t.readOnly.admin} />}
      <form onSubmit={onSubmit} className="mt-6">
        <fieldset disabled={readOnly} className="grid min-w-0 gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="name" required defaultValue={initial?.name} placeholder={o.name} className={input} />
            <input name="website" dir="ltr" defaultValue={initial?.website} placeholder={o.website} className={input} />
            <select name="industry" required defaultValue={initial?.industry ?? ""} className={input}>
              <option value="" disabled>{o.industry}</option>
              {o.industries.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
            <input name="city" defaultValue={initial?.city ?? (lang === "ar" ? "الرياض" : "Riyadh")} placeholder={o.city} className={input} />
            <select name="dialect" defaultValue={initial?.dialect ?? "saudi"} className={input} aria-label={o.dialect}>
              {Object.entries(o.dialects).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label className="text-xs text-ink/70 sm:col-span-2">{o.timeZone}
              <select name="timeZone" defaultValue={zoneOf(initial)} className={`${input} mt-1`} dir="auto">
                {ZONE_IDS.map((z) => <option key={z} value={z}>{`${ZONES[z].city[lang]} (${zoneUtcLabel(z)})`}</option>)}
              </select>
            </label>
            <fieldset className="flex items-center gap-4 text-sm">
              <legend className="sr-only">{o.languages}</legend>
              <span className="text-muted">{o.languages}:</span>
              {(["ar", "en"] as const).map((l) => (
                <label key={l} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={langs.includes(l)} onChange={() => toggle(langs, setLangs, l)} /> {o[l]}
                </label>
              ))}
            </fieldset>
          </div>
          <input name="tone" required defaultValue={initial?.tone} placeholder={o.tone} className={input} />
          <textarea name="products" required rows={3} defaultValue={initial?.products} placeholder={o.products} className={input} />
          <textarea name="audience" required rows={2} defaultValue={initial?.audience} placeholder={o.audience} className={input} />
          <textarea name="offers" rows={2} defaultValue={initial?.offers} placeholder={o.offers} className={input} />
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="competitors" defaultValue={initial?.competitors} placeholder={o.competitors} className={input} />
            <input name="preferred" defaultValue={initial?.preferred} placeholder={o.preferred} className={input} />
          </div>
          <section id="guard" className={`rounded-xl border p-4 ${terms.length ? "border-ink/30 bg-ink/5" : "border-lemon/50 bg-lemon/10"}`}>
            <p className="flex items-center gap-2 font-display font-bold text-ink"><Icon name="shield" className="h-5 w-5" />{G.title}<span className={`badge ms-auto ${terms.length ? "badge-primary" : "badge-accent"}`}>{terms.length ? G.count(terms.length) : G.none}</span></p>
            <p className="mt-1 text-xs text-ink/70">{G.body}</p>
            <input name="banned" value={banned} onChange={(e) => setBanned(e.target.value)} placeholder={o.banned} aria-label={G.title} className={`${input} mt-3`} />
            {terms.length > 0 && <ul className="mt-2 flex flex-wrap gap-1.5">{terms.map((w) => <li key={w} className="pop-in flex items-center gap-1 rounded-full bg-ink px-2.5 py-0.5 text-xs text-lilac" dir="auto"><Icon name="lock" className="h-3 w-3 text-lemon" />{w}</li>)}</ul>}
            <p className="mt-3 text-xs text-muted">{G.examples}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">{G.ex.filter((w) => !terms.some((x) => x.toLowerCase() === w.toLowerCase())).map((w) => <button type="button" key={w} onClick={() => addTerm(w)} className="rounded-full border border-dashed border-ink/40 px-2.5 py-0.5 text-xs text-ink hover:bg-ink hover:text-lilac" dir="auto">+ {w}</button>)}</div>
          </section>
          <fieldset className="flex flex-wrap items-center gap-2 text-sm">
            <legend className="mb-1 w-full text-muted">{o.channels}</legend>
            {CHANNELS.map((c) => (
              <button type="button" key={c} onClick={() => toggle(channels, setChannels, c)} className={`rounded-full border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-60 ${channels.includes(c) ? "border-ink bg-ink text-lilac" : "border-ink/20 bg-white"}`}>
                {c}
              </button>
            ))}
          </fieldset>
          {!readOnly && <button disabled={busy} className="btn btn-primary">{o.save}</button>}
          <p role="status" className="text-sm text-ink">{msg}</p>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        </fieldset>
      </form>
      {initial && <BrandModelField t={t} lang={lang} stored={initial.model} readOnly={readOnly} canConfirmChina={canConfirmChina} />}
    </div>
  );
}
