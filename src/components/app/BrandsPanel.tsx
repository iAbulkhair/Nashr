"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { ONBOARD_EXTRA_BRAND_COST } from "@/lib/pricing";
import ReadOnlyNote from "./ReadOnlyNote";
import Scribble from "@/components/Scribble";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { usePrompt } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Time } from "@/components/ui/Time";

type B = { id: string; name: string; createdAt: string; status: "active" | "archived"; hasBrandFile: boolean };

/**
 * `manage` (owner, admin): add, rename and archive. Everyone else can only switch their own active brand, and sees a
 * note instead of the add form. Display only: POST /api/brands refuses the same roles.
 *
 * Brands are unlimited on every plan (rule 245): no count limit, no upsell. Adding is bounded on the server by a rate
 * limit (429 slow_down) and a lock (409 busy). What an added brand costs is said here before anyone adds one: its setup
 * from its URL uses ONBOARD_EXTRA_BRAND_COST credits (rule 246), and its Sunday plan starts off until switched on (rule 247).
 */
export default function BrandsPanel({ lang, manage = true, readOnlyNote = "" }: { lang: Lang; manage?: boolean; readOnlyNote?: string }) {
  const ar = lang === "ar";
  const r = useRouter();
  const [brands, setBrands] = useState<B[]>([]);
  const [active, setActive] = useState("default");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  // One change at a time: a double click on Add sent two adds, and both passed the rate and the lock (two brands).
  const [busy, setBusy] = useState(false);
  // Rename asks in the app's own dialog (rule 1089), in the page's language, where `window.prompt` asked in the browser's.
  const [ask, promptDialog] = usePrompt(lang);
  async function load() { const j = await (await fetch("/api/brands")).json(); if (j.ok) { setBrands(j.brands); setActive(j.active); } }
  useEffect(() => { void Promise.resolve().then(load); }, []);
  async function act(body: Record<string, string>) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/brands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({ ok: false, error: String(res.status) }));
      if (!j.ok) {
        setErr(
          // Which window refused (src/lib/rate.ts `brandAddRefusal`): the day's can last until tomorrow, so never "shortly".
          j.error === "slow_down" ? (j.retry === "day"
            ? (ar ? "وصلت إلى حد العلامات الجديدة لهذا اليوم. حاول غداً." : "You reached today's limit for new brands. Try again tomorrow.")
            : (ar ? "أضفت علامات كثيرة خلال الساعة الأخيرة. حاول بعد ساعة." : "You added many brands in the last hour. Try again in an hour."))
          : j.error === "busy" ? (ar ? "تغيير آخر على العلامات جارٍ الآن. حاول مرة أخرى." : "Another brand change is in progress. Try again.")
          // Any other refusal says so in words; the route's code is never shown (rule 1091).
          : (ar ? "لم يتم التغيير. حاول مرة أخرى." : "Nothing changed. Try again."),
        );
        return;
      }
      setErr("");
      if (body.action === "add") { r.push(`/${lang}/app/start`); r.refresh(); return; }
      await load(); r.refresh();
    } finally {
      setBusy(false);
    }
  }
  const activeCount = brands.filter((b) => b.status === "active").length;
  async function rename(b: B) {
    const n = await ask({ title: ar ? "إعادة تسمية العلامة" : "Rename the brand", label: ar ? "الاسم الجديد" : "New name", initial: b.name, submitLabel: ar ? "احفظ الاسم" : "Save the name", cancelLabel: ar ? "تراجع" : "Cancel", maxLength: 80 });
    if (n && n !== b.name) await act({ action: "rename", id: b.id, name: n });
  }
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="brandspanel-t1" />{ar ? "العلامات" : "Brands"}</span></h1>
      <p className="mt-2 text-foreground-muted">{ar ? "لكل علامة ملفها ومحتواها وقنواتها وإعداداتها. الكريدت مشترك بين علاماتك." : "Each brand has its own file, content, channels and settings. Credits are shared across brands."}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 card card-sm text-sm">
        <span>{ar ? "العلامات" : "Brands"}: <b dir="ltr">{activeCount}</b></span>
        {manage && (
          <form onSubmit={(e) => { e.preventDefault(); act({ action: "add", name }); }} className="flex w-full min-w-0 items-end gap-2 sm:w-auto">
            <Field label={ar ? "اسم العلامة الجديدة" : "New brand name"} hideLabel className="min-w-0 flex-1">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={ar ? "اسم العلامة الجديدة" : "New brand name"} maxLength={80} />
            </Field>
            <Button type="submit" loading={busy}>+ {ar ? "أضف" : "Add"}</Button>
          </form>
        )}
      </div>
      {manage && (
        <p className="mt-2 text-xs text-foreground-muted">
          {ar
            ? `العلامات بلا حد في كل الخطط. إعداد علامتك الأولى مجاني، وإعداد كل علامة إضافية من رابطها يستخدم ${ONBOARD_EXTRA_BRAND_COST} كريدت من رصيد الحساب عند بدء الإعداد، ويُعاد إن تعذّر بناء ملف العلامة، وتعبئة النموذج يدوياً مجانية. خطة الأحد تبدأ متوقفة للعلامات المضافة، وتفعّلها من «المهام».`
            : `Brands are unlimited on every plan. Your first brand's setup is free; setting up each added brand from its URL uses ${ONBOARD_EXTRA_BRAND_COST} credits from the account's balance when setup starts, refunded if the brand file cannot be built, and filling the form by hand is free. The Sunday plan starts off for added brands; switch it on in Tasks.`}
        </p>
      )}
      {!manage && readOnlyNote && <ReadOnlyNote text={readOnlyNote} />}
      {err && <Callout tone="danger" className="mt-3">{err}</Callout>}
      {promptDialog}
      <ul className="mt-6 grid gap-3">
        {brands.map((b) => (
          <li key={b.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${b.id === active ? "border-border-strong bg-surface" : "border-foreground/10 bg-surface"} ${b.status === "archived" ? "opacity-60" : ""}`}>
            <div>
              <p className="flex flex-wrap items-center gap-2 font-display font-medium"><bdi>{b.name}</bdi>{b.id === active && <Badge tone="inverse">{ar ? "نشطة" : "Active"}</Badge>}{b.status === "archived" && <Badge tone="neutral">{ar ? "مؤرشفة" : "Archived"}</Badge>}{!b.hasBrandFile && <Badge tone="warning">{ar ? "لم يكتمل الإعداد" : "Setup incomplete"}</Badge>}</p>
              <p className="mt-1 text-xs text-foreground-muted"><Time value={b.createdAt} lang={lang} /></p>
            </div>
            <div className="flex flex-wrap gap-2">
              {b.id !== active && b.status === "active" && <Button size="sm" disabled={busy} onClick={() => act({ action: "switch", id: b.id })}>{ar ? "انتقل" : "Switch"}</Button>}
              {manage && <Button variant="secondary" size="sm" disabled={busy} onClick={() => rename(b)}>{ar ? "إعادة تسمية" : "Rename"}</Button>}
              {manage && b.id !== "default" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => act({ action: "archive", id: b.id })}>{b.status === "archived" ? (ar ? "استعادة" : "Restore") : (ar ? "أرشفة" : "Archive")}</Button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
