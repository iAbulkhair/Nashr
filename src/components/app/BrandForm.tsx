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
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

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
  const [err, setErr] = useState("");
  const [langs, setLangs] = useState<string[]>(initial?.languages ?? [lang === "en" ? "en" : "ar"]);
  const [channels, setChannels] = useState<string[]>(initial?.channels ?? ["instagram", "snapchat", "tiktok", "whatsapp"]);
  const [banned, setBanned] = useState(initial?.banned ?? "");
  const G = GUARD[lang];
  const toast = useToast();
  const terms = bannedTerms(banned);
  const addTerm = (w: string) => setBanned((b) => (bannedTerms(b).some((x) => x.toLowerCase() === w.toLowerCase()) ? b : [b.trim(), w].filter(Boolean).join(lang === "ar" ? "، " : ", ")));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (readOnly) return;
    if (busy) return;
    setBusy(true);
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
    // "Saved" is a toast (rule 1088): it stays readable after the first save moves on to the chat.
    toast.success(o.saved);
    if (initial) r.refresh();
    else { r.push(`/${lang}/app/chat`); r.refresh(); }
  }
  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="brandform-t1" />{o.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{o.sub}</p>
      {readOnly && <ReadOnlyNote text={t.readOnly.admin} />}
      <form onSubmit={onSubmit} className="mt-6">
        <fieldset disabled={readOnly} className="grid min-w-0 gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={o.name} required><Input name="name" defaultValue={initial?.name} autoComplete="organization" /></Field>
            <Field label={o.website}><Input name="website" dir="ltr" inputMode="url" autoComplete="url" defaultValue={initial?.website} /></Field>
            <Field label={o.industry} required>
              <Select name="industry" defaultValue={initial?.industry ?? ""}>
                <option value="" disabled>{o.industry}</option>
                {o.industries.map((i) => <option key={i} value={i}>{i}</option>)}
              </Select>
            </Field>
            <Field label={o.city}><Input name="city" defaultValue={initial?.city ?? (lang === "ar" ? "الرياض" : "Riyadh")} /></Field>
            <Field label={o.dialect}>
              <Select name="dialect" defaultValue={initial?.dialect ?? "saudi"}>
                {Object.entries(o.dialects).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label={o.timeZone} className="sm:col-span-2">
              <Select name="timeZone" defaultValue={zoneOf(initial)} dir="auto">
                {ZONE_IDS.map((z) => <option key={z} value={z}>{`${ZONES[z].city[lang]} (${zoneUtcLabel(z)})`}</option>)}
              </Select>
            </Field>
            <fieldset className="flex items-center gap-4 text-sm">
              <legend className="sr-only">{o.languages}</legend>
              <span className="text-foreground-muted">{o.languages}:</span>
              {(["ar", "en"] as const).map((l) => (
                <label key={l} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={langs.includes(l)} onChange={() => toggle(langs, setLangs, l)} /> {o[l]}
                </label>
              ))}
            </fieldset>
          </div>
          <Field label={o.tone} required><Input name="tone" defaultValue={initial?.tone} /></Field>
          <Field label={o.products} required><Textarea name="products" rows={3} defaultValue={initial?.products} /></Field>
          <Field label={o.audience} required><Textarea name="audience" rows={2} defaultValue={initial?.audience} /></Field>
          <Field label={o.offers}><Textarea name="offers" rows={2} defaultValue={initial?.offers} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={o.competitors}><Input name="competitors" defaultValue={initial?.competitors} /></Field>
            <Field label={o.preferred}><Input name="preferred" defaultValue={initial?.preferred} /></Field>
          </div>
          {/* No terms yet is a heads-up, not an error: the notice pair (rule 1080), where it was lemon on a light ground. */}
          <section id="guard" aria-labelledby="guard-title" className={`rounded-xl border-[1.5px] p-4 ${terms.length ? "border-border bg-surface-muted" : "border-notice-border bg-notice-bg"}`}>
            <p id="guard-title" className="flex items-center gap-2 font-display font-bold text-foreground"><Icon name="shield" className="h-5 w-5" />{G.title}<Badge tone={terms.length ? "info" : "warning"} className="ms-auto">{terms.length ? G.count(terms.length) : G.none}</Badge></p>
            <p className="mt-1 text-xs text-foreground-muted">{G.body}</p>
            <Field label={o.banned} className="mt-3"><Input name="banned" value={banned} onChange={(e) => setBanned(e.target.value)} /></Field>
            {terms.length > 0 && <ul className="mt-2 flex flex-wrap gap-1.5">{terms.map((w) => <li key={w} className="pop-in flex items-center gap-1 rounded-full bg-inverse px-2.5 py-0.5 text-xs text-inverse-muted" dir="auto"><Icon name="lock" className="h-3 w-3 text-lemon" />{w}</li>)}</ul>}
            <p className="mt-3 text-xs text-foreground-muted">{G.examples}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">{G.ex.filter((w) => !terms.some((x) => x.toLowerCase() === w.toLowerCase())).map((w) => <button type="button" key={w} onClick={() => addTerm(w)} className="min-h-8 rounded-full border border-dashed border-foreground/40 px-3 py-1 text-xs text-foreground hover:bg-inverse hover:text-inverse-muted" dir="auto">+ {w}</button>)}</div>
          </section>
          <fieldset className="flex flex-wrap items-center gap-2 text-sm">
            <legend className="mb-1 w-full text-foreground-muted">{o.channels}</legend>
            {CHANNELS.map((c) => (
              <button type="button" key={c} aria-pressed={channels.includes(c)} onClick={() => toggle(channels, setChannels, c)} className={`min-h-9 rounded-full border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-60 ${channels.includes(c) ? "border-border-strong bg-inverse text-inverse-muted" : "border-border bg-surface"}`}>
                {c}
              </button>
            ))}
          </fieldset>
          {err && <Callout tone="danger">{err}</Callout>}
          {!readOnly && <Button type="submit" loading={busy} className="justify-self-start">{o.save}</Button>}
        </fieldset>
      </form>
      {initial && <BrandModelField t={t} lang={lang} stored={initial.model} readOnly={readOnly} canConfirmChina={canConfirmChina} />}
    </div>
  );
}
