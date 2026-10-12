"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import { Field, Input, Textarea } from "@/components/ui/Field";
import SettingsCard, { type CardStatus } from "./SettingsCard";
import { readProfile, saveProfile } from "./profileSave";

/** The social handles the brand file keeps (PUT /api/profile `social_*`, the same five). */
export const SOCIAL_KEYS = ["instagram", "snapchat", "tiktok", "x", "linkedin"] as const;
type Social = Partial<Record<(typeof SOCIAL_KEYS)[number], string>>;
export type BrandExtrasInitial = { social: Social; valueProp: string; sitemap: string };

/** A sitemap address the agents can read: empty (none), or an http(s) address. */
export const sitemapValid = (v: string) => !v.trim() || /^https?:\/\/\S+$/i.test(v.trim());

const COPY = {
  ar: {
    save: "حفظ", saving: "يحفظ…", saved: "تم الحفظ.",
    social: "حسابات التواصل", socialSub: "حساباتك لتوليد المحتوى والجدولة. اترك الحقل فارغاً لحذفه.",
    value: "القيمة المميزة", valueSub: "لماذا يختارك العميل دون غيرك؟ يقرؤها الفريق كله في كل توليد.", valuePh: "مثال: توصيل في نفس اليوم داخل الرياض",
    sitemap: "خريطة الموقع", sitemapSub: "لروابط داخلية أفضل في المقالات واستيراد المنتجات.", sitemapBad: "اكتب رابطاً يبدأ بـ https://",
    readOnly: "يعدّل هذه البطاقات مالك الحساب أو المشرف.",
  },
  en: {
    save: "Save", saving: "Saving…", saved: "Saved.",
    social: "Social media", socialSub: "Your handles for content and scheduling. Leave a field empty to remove it.",
    value: "Value proposition", valueSub: "Why does a customer choose you over the alternatives? The whole team reads it on every generation.", valuePh: "e.g. Same-day delivery in Riyadh",
    sitemap: "Sitemap", sitemapSub: "For better internal links in articles and for product import.", sitemapBad: "Use an address that starts with https://",
    readOnly: "The account owner or an admin edits these cards.",
  },
} as const;

const sameSocial = (a: Social, b: Social) => SOCIAL_KEYS.every((k) => (a[k] ?? "").trim() === (b[k] ?? "").trim());

/**
 * Settings, Brand (rule 1152): the brand-file fields the old profile page edited and the brand form does not (social
 * handles, value proposition, sitemap), one card each. Each card sends only its own fields to PUT /api/profile, which
 * checks `brand.write` and saves under the brand lock as before; a member sees the values and no Save.
 */
export default function BrandExtras({ lang, initial, readOnly, forbidden }: { lang: Lang; initial: BrandExtrasInitial; readOnly: boolean; forbidden: string }) {
  const T = COPY[lang];
  const [stored, setStored] = useState(initial);
  const [social, setSocial] = useState<Social>(initial.social);
  const [value, setValue] = useState(initial.valueProp);
  const [sitemap, setSitemap] = useState(initial.sitemap);
  const [busy, setBusy] = useState<"" | "social" | "value" | "sitemap">("");
  const [status, setStatus] = useState<Record<string, CardStatus>>({});
  const say = (k: string, s: CardStatus) => setStatus((p) => ({ ...p, [k]: s }));

  const apply = (b: { social?: Record<string, string>; valueProp?: string; sitemap?: string } | null | undefined) => {
    if (!b) return;
    const next = { social: b.social ?? {}, valueProp: b.valueProp ?? "", sitemap: b.sitemap ?? "" };
    setStored(next); setSocial(next.social); setValue(next.valueProp); setSitemap(next.sitemap);
  };
  async function save(k: "social" | "value" | "sitemap", body: Record<string, string>) {
    setBusy(k); say(k, null);
    const out = await saveProfile(body, lang, forbidden);
    setBusy("");
    if (out.kind === "saved") { apply(out.saved.brand); say(k, { tone: "ok", text: T.saved }); return; }
    if (out.kind === "unknown") { const fresh = await readProfile().catch(() => null); if (fresh?.ok) apply(fresh.brand); }
    say(k, { tone: "error", text: out.text });
  }
  const note = readOnly ? T.readOnly : undefined;

  return (
    <div className="grid gap-4">
      <SettingsCard title={T.social} sub={T.socialSub} note={note} status={status.social ?? null}
        {...(readOnly ? {} : { onSave: () => save("social", Object.fromEntries(SOCIAL_KEYS.map((k) => [`social_${k}`, social[k] ?? ""]))), dirty: !sameSocial(social, stored.social), busy: busy === "social", saveLabel: T.save, savingLabel: T.saving })}>
        <div className="grid gap-3 sm:grid-cols-2">
          {SOCIAL_KEYS.map((k) => (
            <Field key={k} label={k === "x" ? "X (Twitter)" : k[0].toUpperCase() + k.slice(1)}>
              <Input name={`social_${k}`} dir="ltr" placeholder="@" value={social[k] ?? ""} readOnly={readOnly} maxLength={80} onChange={(e) => setSocial((p) => ({ ...p, [k]: e.target.value }))} />
            </Field>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title={T.value} sub={T.valueSub} note={note} status={status.value ?? null}
        {...(readOnly ? {} : { onSave: () => save("value", { valueProp: value }), dirty: value.trim() !== stored.valueProp.trim(), busy: busy === "value", saveLabel: T.save, savingLabel: T.saving })}>
        <Field label={T.value}>
          <Textarea name="valueProp" rows={2} maxLength={500} value={value} readOnly={readOnly} placeholder={T.valuePh} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </SettingsCard>

      <SettingsCard title={T.sitemap} sub={T.sitemapSub} note={note} status={status.sitemap ?? null}
        {...(readOnly ? {} : { onSave: () => save("sitemap", { sitemap }), dirty: sitemap.trim() !== stored.sitemap.trim(), valid: sitemapValid(sitemap), busy: busy === "sitemap", saveLabel: T.save, savingLabel: T.saving })}>
        <Field label={T.sitemap} error={sitemapValid(sitemap) ? undefined : T.sitemapBad}>
          <Input name="sitemap" dir="ltr" inputMode="url" placeholder="https://example.com/sitemap.xml" maxLength={300} value={sitemap} readOnly={readOnly} onChange={(e) => setSitemap(e.target.value)} />
        </Field>
      </SettingsCard>
    </div>
  );
}
