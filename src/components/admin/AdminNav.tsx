"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ADMIN_LEADS_SEEN, ADMIN_SECTIONS, adminHref, type AdminSection } from "@/lib/admin-gate";
import { adminFetch } from "@/lib/admin-fetch";
import LangToggle from "../LangToggle";
import { Icon, type IconName } from "../app/Icons";

export const ADMIN_LABEL: Record<"en" | "ar", Record<AdminSection, string>> = {
  en: { overview: "Overview", users: "Users", leads: "Leads", usage: "Usage", billing: "Billing", partners: "Partners", quality: "Quality", wishlist: "Wishlist", log: "Audit log" },
  ar: { overview: "نظرة عامة", users: "المستخدمون", leads: "العملاء المحتملون", usage: "الاستخدام", billing: "الفوترة", partners: "الشركاء", quality: "الجودة", wishlist: "الأمنيات", log: "سجل الإجراءات" },
};
const ICON: Record<AdminSection, IconName> = { overview: "dashboard", users: "users", leads: "inbox", usage: "chart", billing: "finance", partners: "gift", quality: "check", wishlist: "spark", log: "clock" };
const T = {
  ar: { title: "لوحة المؤسس", back: "العودة للتطبيق", endKey: "إنهاء جلسة المفتاح", menu: "القائمة" },
  en: { title: "Founder console", back: "Back to the app", endKey: "End key session", menu: "Menu" },
} as const;

/**
 * The founder console's own sidebar (rule 871): its sections, the new-leads badge, «العودة للتطبيق» for a founder signed
 * in as themselves, and "end key session" for a key session. No agent, chat, credit, brand or trial element. Under `lg`
 * it folds into a header with a menu button, like the customer sidebar.
 */
export default function AdminNav({ lang, keySession, founder }: { lang: "ar" | "en"; keySession: boolean; founder: boolean }) {
  const S = T[lang];
  const path = usePathname() ?? "";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Sales leads the founder has not seen yet (#134), cleared when the Leads section shows them (ADMIN_LEADS_SEEN).
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    adminFetch("/api/admin/leads?limit=0").then((r) => r.json()).then((j) => j.ok && setUnread(j.unread)).catch(() => {});
    const seen = () => setUnread(0);
    window.addEventListener(ADMIN_LEADS_SEEN, seen);
    return () => window.removeEventListener(ADMIN_LEADS_SEEN, seen);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = (s: AdminSection) => (s === "overview" ? path === adminHref(lang, s) : path.startsWith(adminHref(lang, s)));
  const body = (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href={adminHref(lang, "overview")} onClick={() => setOpen(false)} className="font-display text-lg font-bold">{S.title}</Link>
        <LangToggle lang={lang} size="sm" />
      </div>
      <nav className="grid gap-0.5">
        {ADMIN_SECTIONS.map((s) => (
          <Link key={s} href={adminHref(lang, s)} onClick={() => setOpen(false)} aria-current={active(s) ? "page" : undefined} className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition ${active(s) ? "bg-lilac font-semibold text-ink" : "text-muted hover:bg-lilac/60 hover:text-ink"}`}>
            <span className="flex items-center gap-2"><Icon name={ICON[s]} className="h-4 w-4" />{ADMIN_LABEL[lang][s]}</span>
            {s === "leads" && unread > 0 && <span className="tnum rounded-full bg-lemon px-1.5 text-xs font-semibold text-ink" data-testid="leads-unread" dir="ltr">{unread}</span>}
          </Link>
        ))}
      </nav>
      <div className="mt-auto grid gap-2 border-t-[1.5px] border-ink/10 pt-3">
        {founder && <Link href={`/${lang}/app`} className="btn btn-secondary btn-sm">{S.back}</Link>}
        {keySession && (
          // Ends the key session on the server (DELETE /api/admin/login), so the same cookie never opens the console again.
          <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { await adminFetch("/api/admin/login", { method: "DELETE" }).catch(() => null); router.push(`/${lang}`); router.refresh(); }}>{S.endKey}</button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-e-[1.5px] border-ink bg-paper text-ink lg:block">{body}</aside>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b-[1.5px] border-ink bg-paper px-4 py-3 text-ink lg:hidden">
        <Link href={adminHref(lang, "overview")} className="font-display text-lg font-bold">{S.title}</Link>
        <button onClick={() => setOpen(!open)} aria-label={S.menu} aria-expanded={open} className="rounded-md border-[1.5px] border-ink p-1.5"><Icon name="menu" className="h-5 w-5" /></button>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-ink/40" />
          <aside className="absolute inset-y-0 start-0 w-72 border-e-[1.5px] border-ink bg-paper text-ink" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} aria-label={S.menu} className="absolute end-2 top-2 rounded-md p-1.5 text-ink hover:bg-lilac"><Icon name="x" className="h-5 w-5" /></button>
            {body}
          </aside>
        </div>
      )}
    </>
  );
}
