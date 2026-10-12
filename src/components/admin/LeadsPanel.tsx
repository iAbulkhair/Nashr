"use client";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { ADMIN_LEADS_SEEN } from "@/lib/admin-gate";
import type { Lead, LeadKind } from "@/lib/leads";

/** GET /api/admin/leads. */
type Page = { leads: Lead[]; total: number; unread: number; seenAt: string | null; scanCap: number; mail: { ready: boolean; forwardTo: boolean } };

const PAGE = 50;
const S = {
  en: {
    title: "Leads", note: "Enterprise and early-customer requests and affiliate applications, newest first. Visitors were told the team will reply soon.",
    sales: "Sales leads", all: "All tickets", when: "Date", type: "Type", who: "Name / company", message: "Message", contact: "Contact",
    none: "No leads yet.", loading: "Loading…", failed: "Could not load the leads", prev: "Newer", next: "Older", export: "Export CSV", isNew: "new",
    mailOff: "Email is not fully set up (MAIL_FROM on a verified domain), so new leads may not reach your inbox. Check this tab daily until it is. Affiliate applications are never emailed and appear only here.",
    noForward: "WAITLIST_TO is not set, so no enterprise or early-customer request is emailed to you. Affiliate applications are never emailed. This tab is the only place they all appear.",
    kinds: { enterprise: "Enterprise", "early-adopter": "Early customer", affiliate: "Affiliate", support: "Support" } as Record<LeadKind, string>,
    of: "of",
  },
  ar: {
    title: "العملاء المحتملون", note: "طلبات الشركات والعملاء الأوائل وطلبات برنامج الشركاء، الأحدث أولاً. قيل للزائر إن الفريق سيرد قريباً.",
    sales: "طلبات المبيعات", all: "كل التذاكر", when: "التاريخ", type: "النوع", who: "الاسم / الشركة", message: "الرسالة", contact: "التواصل",
    none: "لا طلبات بعد.", loading: "جارٍ التحميل…", failed: "تعذّر تحميل الطلبات", prev: "الأحدث", next: "الأقدم", export: "تصدير CSV", isNew: "جديد",
    mailOff: "البريد غير مفعّل بالكامل (يلزم MAIL_FROM على دومين موثَّق)، فقد لا تصل الطلبات الجديدة إلى بريدك. راجع هذا التبويب يومياً حتى يُفعَّل. طلبات برنامج الشركاء لا تُرسل بالبريد أصلاً وتظهر هنا فقط.",
    noForward: "WAITLIST_TO غير مضبوط، فلا يصلك بالبريد أي طلب من الشركات أو العملاء الأوائل. وطلبات برنامج الشركاء لا تُرسل بالبريد أصلاً. هذا التبويب هو المكان الوحيد الذي تظهر فيه كلها.",
    kinds: { enterprise: "شركات", "early-adopter": "من العملاء الأوائل", affiliate: "شريك", support: "دعم" } as Record<LeadKind, string>,
    of: "من",
  },
} as const;

/**
 * Founder console, Leads section (#134). Opening it marks every lead up to now as read, then fires `ADMIN_LEADS_SEEN` on
 * `window` so the sidebar's unread badge clears (src/components/admin/AdminNav.tsx).
 * Every value is visitor-typed and rendered as text only.
 */
export default function LeadsPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [all, setAll] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async (nextAll: boolean, nextOffset: number): Promise<Page | null> => {
    setErr("");
    const r = await adminFetch(`/api/admin/leads?limit=${PAGE}&offset=${nextOffset}${nextAll ? "&all=1" : ""}`).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (!j?.ok) { setErr(`${L.failed}${r ? ` (HTTP ${r.status})` : ""}`); return null; }
    setPage(j as Page);
    return j as Page;
  }, [L.failed]);

  useEffect(() => {
    const seen = () => window.dispatchEvent(new Event(ADMIN_LEADS_SEEN));
    void Promise.resolve().then(() => load(false, 0)).then(async (first) => {
      if (!first) return;
      // Read up to the newest sales lead on screen (the first row: sales leads, newest first), not up to the server's
      // clock: a lead that arrives between this load and the POST was never shown and stays unread.
      const until = first.leads[0]?.at;
      if (!until) { seen(); return; }
      const r = await adminFetch("/api/admin/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "seen", until }) }).catch(() => null);
      if (r?.ok) seen();
    });
  }, [load]);

  const go = (nextAll: boolean, nextOffset: number) => { setAll(nextAll); setOffset(nextOffset); void load(nextAll, nextOffset); };
  const at = (v: string) => (v ? v.slice(0, 16).replace("T", " ") : "—");

  return (
    <section className="card card-sm" data-testid="leads-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-foreground">{L.title}</h2>
        <div className="flex flex-wrap gap-2 text-sm">
          <button type="button" onClick={() => go(false, 0)} aria-pressed={!all} className={`rounded-full px-3 py-1 ${!all ? "bg-inverse text-inverse-muted" : "bg-background-muted"}`}>{L.sales}</button>
          <button type="button" onClick={() => go(true, 0)} aria-pressed={all} className={`rounded-full px-3 py-1 ${all ? "bg-inverse text-inverse-muted" : "bg-background-muted"}`}>{L.all}</button>
          <button type="button" onClick={() => window.open(`/api/admin/leads?format=csv${all ? "&all=1" : ""}`, "_blank")} className="btn btn-secondary btn-xs">{L.export}</button>
        </div>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">{L.note}</p>
      {page && !page.mail.ready && <p role="alert" className="mt-3 rounded-lg bg-agent-sami/20 px-3 py-2 text-sm text-danger">{L.mailOff}</p>}
      {page && page.mail.ready && !page.mail.forwardTo && <p role="alert" className="mt-3 rounded-lg bg-agent-sami/20 px-3 py-2 text-sm text-danger">{L.noForward}</p>}
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      {!page && !err ? <p className="mt-3 text-sm text-foreground-muted">{L.loading}</p> : page && page.leads.length === 0 ? <p className="mt-3 text-sm text-foreground-muted">{L.none}</p> : page && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-background-muted text-start text-xs uppercase tracking-wide text-foreground-muted">
              <tr><th className="p-2 text-start">{L.when}</th><th className="text-start">{L.type}</th><th className="text-start">{L.who}</th><th className="text-start">{L.message}</th><th className="text-start">{L.contact}</th></tr>
            </thead>
            <tbody>
              {page.leads.map((l, i) => {
                const fresh = l.kind !== "support" && (!page.seenAt || l.at > page.seenAt);
                return (
                  <tr key={`${l.at}-${i}`} className="border-t border-foreground/5 align-top">
                    <td className="whitespace-nowrap p-2 font-mono text-xs" dir="ltr">{at(l.at)}{fresh && <span className="ms-2 rounded bg-lemon px-1.5 font-sans text-[10px] font-semibold text-accent-foreground">{L.isNew}</span>}</td>
                    <td className="whitespace-nowrap text-xs">{L.kinds[l.kind]}{l.kind === "support" && <span className="text-foreground-muted"> · {l.type}</span>}</td>
                    <td className="text-xs" dir="auto">{l.name || "—"}{l.company && <div className="text-foreground-muted">{l.company}</div>}</td>
                    <td className="max-w-md text-xs" dir="auto"><p className="line-clamp-4 whitespace-pre-wrap break-words">{l.message}</p>{l.page && <p className="mt-1 font-mono text-[10px] text-foreground-muted" dir="ltr">{l.page} · {l.lang}</p>}</td>
                    <td className="text-xs" dir="ltr">
                      {l.email && <a href={`mailto:${l.email}`} className="text-foreground underline">{l.email}</a>}
                      {l.phone && <div><a href={`https://wa.me/${l.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="underline">{l.phone}</a></div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-2 text-xs text-foreground-muted">
            <button type="button" disabled={offset === 0} onClick={() => go(all, Math.max(0, offset - PAGE))} className="btn btn-secondary btn-xs">{L.prev}</button>
            <span className="tnum">{offset + 1}–{Math.min(offset + PAGE, page.total)} {L.of} {page.total}</span>
            <button type="button" disabled={offset + PAGE >= page.total} onClick={() => go(all, offset + PAGE)} className="btn btn-secondary btn-xs">{L.next}</button>
          </div>
        </div>
      )}
    </section>
  );
}
