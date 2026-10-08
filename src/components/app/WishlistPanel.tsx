"use client";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { TITLE_MAX, WISH_STATUSES, type Bi, type WishArea, type WishStatus } from "@/lib/changelog";
import { useConfirm } from "./ConfirmDialog";

type Item = { id: string; title: Bi; area: WishArea | null; status: WishStatus; votes: number; seeded: boolean; hidden: boolean };
type Sugg = { id: string; email: string; text: string; lang: "ar" | "en"; at: string };

const AREAS: WishArea[] = ["agents", "onboarding", "content", "channels", "commerce", "ads", "reports", "team", "billing", "integrations", "app"];
const S = {
  en: { queue: "Suggestions to review", queueNote: "Only you see these. Promote writes a public title in both languages; the suggester's text is never published as is.", none: "No suggestions waiting.", promote: "Promote", dismiss: "Dismiss", newItem: "Add a wish yourself", titleAr: "Public title (Arabic)", titleEn: "Public title (English)", area: "Area", noArea: "No area", publish: "Publish to the wishlist", cancel: "Cancel", back: "Go back", items: "Wishlist items", votes: "Votes", status: "Status", seeded: "in code", promoted: "promoted", hidden: "hidden", hide: "Hide", del: "Delete", restore: "Show again", confirmDel: "Delete this wish and its votes?", loading: "Loading…", failed: "Failed", statuses: { planned: "Planned", in_progress: "In progress", shipped: "Shipped" } },
  ar: { queue: "اقتراحات للمراجعة", queueNote: "لا يراها غيرك. الترقية تكتب عنواناً عاماً باللغتين؛ نص المقترح لا يُنشر كما هو.", none: "لا اقتراحات بانتظار المراجعة.", promote: "رقِّ إلى القائمة", dismiss: "تجاهل", newItem: "أضف أمنية بنفسك", titleAr: "العنوان العام (عربي)", titleEn: "العنوان العام (إنجليزي)", area: "المجال", noArea: "بلا مجال", publish: "انشر في قائمة الأمنيات", cancel: "إلغاء", back: "رجوع", items: "عناصر القائمة", votes: "الأصوات", status: "الحالة", seeded: "في الكود", promoted: "مُرقّاة", hidden: "مخفية", hide: "إخفاء", del: "حذف", restore: "إظهار", confirmDel: "حذف هذه الأمنية وأصواتها؟", loading: "جارٍ التحميل…", failed: "فشل", statuses: { planned: "مخطط", in_progress: "قيد العمل", shipped: "أُطلق" } },
} as const;

function PromoteForm({ lang, initial, suggestionId, onDone, onCancel }: { lang: "ar" | "en"; initial?: Partial<Bi>; suggestionId?: string; onDone: (msg: string) => void; onCancel?: () => void }) {
  const L = S[lang];
  const [ar, setAr] = useState(initial?.ar ?? "");
  const [en, setEn] = useState(initial?.en ?? "");
  const [area, setArea] = useState<WishArea | "">("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await adminFetch("/api/admin/wishlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "promote", title: { ar, en }, area: area || undefined, suggestionId }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (j.ok) { setAr(""); setEn(""); setArea(""); }
    onDone(j.ok ? `✓ ${en || ar}` : `${L.failed}: ${j.error ?? r.status}`);
  }
  return (
    <form onSubmit={submit} className="mt-2 grid gap-2 sm:grid-cols-2">
      <input value={ar} onChange={(e) => setAr(e.target.value)} maxLength={TITLE_MAX} dir="rtl" placeholder={L.titleAr} aria-label={L.titleAr} className="input" required />
      <input value={en} onChange={(e) => setEn(e.target.value)} maxLength={TITLE_MAX} dir="ltr" placeholder={L.titleEn} aria-label={L.titleEn} className="input" required />
      <select value={area} onChange={(e) => setArea(e.target.value as WishArea | "")} aria-label={L.area} className="input">
        <option value="">{L.noArea}</option>
        {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !ar.trim() || !en.trim()} className="btn btn-primary btn-sm">{L.publish}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">{L.cancel}</button>}
      </div>
    </form>
  );
}

/** Founder console, Wishlist tab: review suggestions, promote them under a public title, set statuses, hide or delete. */
export default function WishlistPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [data, setData] = useState<{ suggestions: Sugg[]; items: Item[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  // Above the early return below: hooks run on every render.
  const [ask, confirmDialog] = useConfirm();
  const load = useCallback(async () => {
    const j = await adminFetch("/api/admin/wishlist").then((r) => r.json()).catch(() => ({}));
    if (j.ok) setData({ suggestions: j.suggestions, items: j.items });
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function act(body: Record<string, unknown>) {
    const r = await adminFetch("/api/admin/wishlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setMsg(j.ok ? `${String(body.action)} ✓` : `${L.failed}: ${j.error ?? r.status}`);
    await load();
  }
  const done = async (m: string) => { setMsg(m); setOpen(null); await load(); };

  if (!data) return <p className="text-sm text-muted">{L.loading}</p>;
  return (
    <div className="grid gap-6">
      {msg && <p className="text-sm text-ink">{msg}</p>}
      <section className="card card-sm">
        <h2 className="font-display text-lg font-semibold text-ink">{L.queue} <span className="tnum text-sm text-muted" dir="ltr">({data.suggestions.length})</span></h2>
        <p className="text-xs text-muted">{L.queueNote}</p>
        {data.suggestions.length === 0 ? <p className="mt-3 text-sm text-muted">{L.none}</p> : (
          <ul className="mt-3 grid gap-2">
            {data.suggestions.map((s) => (
              <li key={s.id} className="rounded-lg border border-ink/10 p-3 text-sm">
                <p className="whitespace-pre-wrap" dir="auto">{s.text}</p>
                <p className="mt-1 text-xs text-muted"><span dir="ltr">{s.email}</span> · {s.lang} · <span className="tnum" dir="ltr">{s.at.slice(0, 16).replace("T", " ")}</span></p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => setOpen(open === s.id ? null : s.id)} className="btn btn-primary btn-xs">{L.promote}</button>
                  <button onClick={() => act({ action: "dismiss", suggestionId: s.id })} className="btn btn-secondary btn-xs">{L.dismiss}</button>
                </div>
                {open === s.id && <PromoteForm lang={lang} initial={{ [s.lang]: s.text.slice(0, TITLE_MAX) }} suggestionId={s.id} onDone={done} onCancel={() => setOpen(null)} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card card-sm">
        <h2 className="font-display text-lg font-semibold text-ink">{L.newItem}</h2>
        <PromoteForm lang={lang} onDone={done} />
      </section>

      <section className="card card-sm overflow-x-auto">
        <h2 className="font-display text-lg font-semibold text-ink">{L.items} <span className="tnum text-sm text-muted" dir="ltr">({data.items.length})</span></h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs text-muted"><tr><th className="p-1 text-start">{lang === "ar" ? "الأمنية" : "Wish"}</th><th className="p-1">{L.votes}</th><th className="p-1">{L.status}</th><th className="p-1" /></tr></thead>
          <tbody>
            {data.items.map((w) => (
              <tr key={w.id} className={`border-t border-ink/5 ${w.hidden ? "opacity-50" : ""}`}>
                <td className="p-1"><span dir="auto">{w.title[lang]}</span> <span className="text-xs text-muted">· {w.seeded ? L.seeded : L.promoted}{w.hidden ? ` · ${L.hidden}` : ""}</span></td>
                <td className="tnum p-1 text-center" dir="ltr">{w.votes}</td>
                <td className="p-1 text-center">
                  <select value={w.status} onChange={(e) => act({ action: "status", id: w.id, status: e.target.value })} aria-label={`${L.status}: ${w.title[lang]}`} className="rounded border border-ink/15 bg-white px-1 py-0.5 text-xs">
                    {WISH_STATUSES.map((st) => <option key={st} value={st}>{L.statuses[st]}</option>)}
                  </select>
                </td>
                <td className="p-1 text-end">
                  {w.hidden
                    ? <button onClick={() => act({ action: "restore", id: w.id })} className="btn btn-secondary btn-xs">{L.restore}</button>
                    : <button onClick={async () => { if (w.seeded || (await ask({ title: w.title[lang], message: L.confirmDel, confirmLabel: L.del, cancelLabel: L.back, destructive: true }))) void act({ action: "delete", id: w.id }); }} className="btn btn-danger btn-xs">{w.seeded ? L.hide : L.del}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {confirmDialog}
    </div>
  );
}
