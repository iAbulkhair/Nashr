"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { ONBOARD_EXTRA_BRAND_COST } from "@/lib/pricing";
import ReadOnlyNote from "./ReadOnlyNote";
import Scribble from "@/components/Scribble";

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
          : j.error,
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
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="brandspanel-t1" />{ar ? "العلامات" : "Brands"}</span></h1>
      <p className="mt-2 text-ink/70">{ar ? "لكل علامة ملفها ومحتواها وقنواتها وإعداداتها. الكريدت مشترك بين علاماتك." : "Each brand has its own file, content, channels and settings. Credits are shared across brands."}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 card card-sm text-sm">
        <span>{ar ? "العلامات" : "Brands"}: <b dir="ltr">{activeCount}</b></span>
        {manage && (
          <form onSubmit={(e) => { e.preventDefault(); act({ action: "add", name }); }} className="flex w-full min-w-0 gap-2 sm:w-auto">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={ar ? "اسم العلامة الجديدة" : "New brand name"} className="w-full min-w-0 flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            <button disabled={busy} className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-lilac disabled:opacity-50">+ {ar ? "أضف" : "Add"}</button>
          </form>
        )}
      </div>
      {manage && (
        <p className="mt-2 text-xs text-ink/60">
          {ar
            ? `العلامات بلا حد في كل الخطط. إعداد علامتك الأولى مجاني، وإعداد كل علامة إضافية من رابطها يستخدم ${ONBOARD_EXTRA_BRAND_COST} كريدت من رصيد الحساب عند بدء الإعداد، ويُعاد إن تعذّر بناء ملف العلامة، وتعبئة النموذج يدوياً مجانية. خطة الأحد تبدأ متوقفة للعلامات المضافة، وتفعّلها من «المهام».`
            : `Brands are unlimited on every plan. Your first brand's setup is free; setting up each added brand from its URL uses ${ONBOARD_EXTRA_BRAND_COST} credits from the account's balance when setup starts, refunded if the brand file cannot be built, and filling the form by hand is free. The Sunday plan starts off for added brands; switch it on in Tasks.`}
        </p>
      )}
      {!manage && readOnlyNote && <ReadOnlyNote text={readOnlyNote} />}
      {err && <p role="alert" className="mt-3 text-sm text-danger">{err}</p>}
      <ul className="mt-6 grid gap-3">
        {brands.map((b) => (
          <li key={b.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${b.id === active ? "border-ink bg-white" : "border-ink/10 bg-white"} ${b.status === "archived" ? "opacity-60" : ""}`}>
            <div>
              <p className="font-display font-medium" dir="auto">{b.name} {b.id === active && <span className="ms-2 rounded bg-ink px-2 py-0.5 text-xs text-lilac">{ar ? "نشطة" : "ACTIVE"}</span>} {b.status === "archived" && <span className="ms-2 rounded bg-ink/10 px-2 py-0.5 text-xs">{ar ? "مؤرشفة" : "archived"}</span>}</p>
              <p className="mt-1 text-xs text-ink/50" dir="ltr">{b.createdAt.slice(0, 10)}{!b.hasBrandFile && (ar ? " · لم يكتمل الإعداد" : " · setup incomplete")}</p>
            </div>
            <div className="flex gap-2 text-xs">
              {b.id !== active && b.status === "active" && <button disabled={busy} onClick={() => act({ action: "switch", id: b.id })} className="rounded-full bg-ink px-3 py-1 font-semibold text-lilac disabled:opacity-50">{ar ? "انتقل" : "Switch"}</button>}
              {manage && <button disabled={busy} onClick={() => { const n = prompt(ar ? "الاسم الجديد:" : "New name:", b.name); if (n) act({ action: "rename", id: b.id, name: n }); }} className="btn btn-secondary btn-xs">{ar ? "إعادة تسمية" : "Rename"}</button>}
              {manage && b.id !== "default" && <button disabled={busy} onClick={() => act({ action: "archive", id: b.id })} className="btn btn-secondary btn-xs">{b.status === "archived" ? (ar ? "استعادة" : "Restore") : (ar ? "أرشفة" : "Archive")}</button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
