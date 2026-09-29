"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import ReadOnlyNote from "./ReadOnlyNote";

type B = { id: string; name: string; createdAt: string; status: "active" | "archived"; hasBrandFile: boolean };

/**
 * `manage` (owner, admin): add, rename and archive. Everyone else can only switch their own active brand, and sees a
 * note instead of the add form. Display only: POST /api/brands refuses the same roles.
 */
export default function BrandsPanel({ lang, manage = true, readOnlyNote = "" }: { lang: Lang; manage?: boolean; readOnlyNote?: string }) {
  const ar = lang === "ar";
  const r = useRouter();
  const [brands, setBrands] = useState<B[]>([]);
  const [active, setActive] = useState("default");
  const [limit, setLimit] = useState(1);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  async function load() { const j = await (await fetch("/api/brands")).json(); if (j.ok) { setBrands(j.brands); setActive(j.active); setLimit(j.limit); } }
  useEffect(() => { void Promise.resolve().then(load); }, []);
  async function act(body: Record<string, string>) {
    const res = await fetch("/api/brands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!j.ok) { setErr(j.error === "limit" ? (ar ? `وصلت حد ${j.limit} علامة لخطتك. ارفع لخطة الوكالة لـ 5 علامات.` : `You've reached your plan's limit of ${j.limit}. Upgrade to Agency for 5 brands.`) : j.error); return; }
    setErr("");
    if (body.action === "add") { r.push(`/${lang}/app/start`); r.refresh(); return; }
    await load(); r.refresh();
  }
  const activeCount = brands.filter((b) => b.status === "active").length;
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{ar ? "العلامات" : "Brands"}</h1>
      <p className="mt-2 text-ink/70">{ar ? "لكل علامة ملفها ومحتواها وقنواتها وإعداداتها. الكريدت مشترك بين علاماتك." : "Each brand has its own file, content, channels and settings. Credits are shared across brands."}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 card card-sm text-sm">
        <span>{ar ? "العلامات" : "Brands"}: <b dir="ltr">{activeCount} / {limit}</b></span>
        {manage && (
          <form onSubmit={(e) => { e.preventDefault(); act({ action: "add", name }); }} className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={ar ? "اسم العلامة الجديدة" : "New brand name"} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            <button disabled={activeCount >= limit} className="rounded-lg bg-oasis px-4 py-2 text-sm font-semibold text-mist disabled:opacity-50">+ {ar ? "أضف" : "Add"}</button>
          </form>
        )}
      </div>
      {!manage && readOnlyNote && <ReadOnlyNote text={readOnlyNote} />}
      {err && <p className="mt-3 text-sm text-sadu">{err} {err.includes("Agency") || err.includes("الوكالة") ? <a href={`/${lang}/app/billing`} className="underline">{ar ? "الاشتراك" : "Subscription"}</a> : null}</p>}
      <ul className="mt-6 grid gap-3">
        {brands.map((b) => (
          <li key={b.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${b.id === active ? "border-oasis bg-white" : "border-ink/10 bg-white"} ${b.status === "archived" ? "opacity-60" : ""}`}>
            <div>
              <p className="font-display font-medium" dir="auto">{b.name} {b.id === active && <span className="ms-2 rounded bg-oasis px-2 py-0.5 text-xs text-mist">{ar ? "نشطة" : "ACTIVE"}</span>} {b.status === "archived" && <span className="ms-2 rounded bg-ink/10 px-2 py-0.5 text-xs">{ar ? "مؤرشفة" : "archived"}</span>}</p>
              <p className="mt-1 text-xs text-ink/50" dir="ltr">{b.createdAt.slice(0, 10)}{!b.hasBrandFile && (ar ? " · لم يكتمل الإعداد" : " · setup incomplete")}</p>
            </div>
            <div className="flex gap-2 text-xs">
              {b.id !== active && b.status === "active" && <button onClick={() => act({ action: "switch", id: b.id })} className="rounded-full bg-oasis px-3 py-1 font-semibold text-mist">{ar ? "انتقل" : "Switch"}</button>}
              {manage && <button onClick={() => { const n = prompt(ar ? "الاسم الجديد:" : "New name:", b.name); if (n) act({ action: "rename", id: b.id, name: n }); }} className="btn btn-secondary btn-xs">{ar ? "إعادة تسمية" : "Rename"}</button>}
              {manage && b.id !== "default" && <button onClick={() => act({ action: "archive", id: b.id })} className="btn btn-secondary btn-xs">{b.status === "archived" ? (ar ? "استعادة" : "Restore") : (ar ? "أرشفة" : "Archive")}</button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
