"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ADMIN_LABEL, ADMIN_LEADS_SEEN, ADMIN_SECTIONS, adminHref, type AdminSection } from "@/lib/admin-gate";
import { adminFetch } from "@/lib/admin-fetch";
import LangToggle from "../LangToggle";
import ThemeToggle from "@/components/ui/ThemeToggle";
import { Icon, type IconName } from "../app/Icons";
import { SW } from "@/lib/staff-words";
import { appHref } from "@/lib/ws-path";

const ICON: Record<AdminSection, IconName> = { overview: "dashboard", users: "users", leads: "inbox", newsletter: "email", usage: "chart", billing: "finance", partners: "gift", quality: "check", skills: "strategy", integrations: "plug", mail: "email", wishlist: "spark", log: "clock" };
const T = {
  ar: { title: "لوحة المؤسس", back: "العودة للتطبيق", endKey: "إنهاء جلسة المفتاح", menu: "القائمة", staffLinks: "حساب الموظف" },
  en: { title: "Founder console", back: "Back to the app", endKey: "End key session", menu: "Menu", staffLinks: "Staff login" },
} as const;

/**
 * The founder console's own sidebar (rule 871): its sections, the new-leads badge, «العودة للتطبيق» for a founder signed
 * in as themselves, and "end key session" for a key session. No agent, chat, credit, brand or trial element. Under `lg`
 * it folds into a header with a menu button, like the customer sidebar.
 *
 * Staff identity (rules 1638, 1640): a staff owner and a key session see "Staff"; a staff session sees "My account" and
 * "Sign out", which deletes the staff session on the server (DELETE /api/admin/staff/login).
 */
export default function AdminNav({ lang, keySession, founder, staff = null }: { lang: "ar" | "en"; keySession: boolean; founder: boolean; staff?: { role: string } | null }) {
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
      <nav aria-label={lang === "ar" ? "أقسام لوحة المؤسس" : "Founder console sections"} className="grid gap-0.5">
        {ADMIN_SECTIONS.map((s) => (
          <Link key={s} href={adminHref(lang, s)} onClick={() => setOpen(false)} aria-current={active(s) ? "page" : undefined} className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition ${active(s) ? "bg-background-muted font-semibold text-foreground" : "text-foreground-muted hover:bg-background-muted/60 hover:text-foreground"}`}>
            <span className="flex items-center gap-2"><Icon name={ICON[s]} className="h-4 w-4" />{ADMIN_LABEL[lang][s]}</span>
            {s === "leads" && unread > 0 && <span className="tnum rounded-full bg-lemon px-1.5 text-xs font-semibold text-accent-foreground" data-testid="leads-unread" dir="ltr">{unread}</span>}
          </Link>
        ))}
      </nav>
      {(staff || keySession) && (
        <nav aria-label={S.staffLinks} className="grid gap-0.5">
          {(staff?.role === "owner" || keySession) && (
            <Link href={`/${lang}/admin/staff`} onClick={() => setOpen(false)} aria-current={path.startsWith(`/${lang}/admin/staff`) ? "page" : undefined} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${path.startsWith(`/${lang}/admin/staff`) ? "bg-background-muted font-semibold text-foreground" : "text-foreground-muted hover:bg-background-muted/60 hover:text-foreground"}`}><Icon name="users" className="h-4 w-4" />{SW[lang].staffLink}</Link>
          )}
          {staff && (
            <Link href={`/${lang}/admin/account`} onClick={() => setOpen(false)} aria-current={path.startsWith(`/${lang}/admin/account`) ? "page" : undefined} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${path.startsWith(`/${lang}/admin/account`) ? "bg-background-muted font-semibold text-foreground" : "text-foreground-muted hover:bg-background-muted/60 hover:text-foreground"}`}><Icon name="check" className="h-4 w-4" />{SW[lang].accountLink}</Link>
          )}
        </nav>
      )}
      <div className="mt-auto grid gap-2 border-t-[1.5px] border-foreground/10 pt-3">
        {/* Rule 1204: the same theme choice as the app's account menu. */}
        <ThemeToggle lang={lang} size="sm" className="justify-self-start" />
        {founder && <Link href={appHref(lang)} className="btn btn-secondary btn-sm">{S.back}</Link>}
        {staff && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { await adminFetch("/api/admin/staff/login", { method: "DELETE" }).catch(() => null); router.push(`/${lang}/admin/login`); router.refresh(); }}>{SW[lang].signOut}</button>
        )}
        {keySession && (
          // Ends the key session on the server (DELETE /api/admin/login), so the same cookie never opens the console again.
          <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { await adminFetch("/api/admin/login", { method: "DELETE" }).catch(() => null); router.push(`/${lang}`); router.refresh(); }}>{S.endKey}</button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-e-[1.5px] border-border-strong bg-surface text-foreground lg:block">{body}</aside>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b-[1.5px] border-border-strong bg-surface px-4 py-3 text-foreground lg:hidden">
        <Link href={adminHref(lang, "overview")} className="font-display text-lg font-bold">{S.title}</Link>
        <button onClick={() => setOpen(!open)} aria-label={S.menu} aria-expanded={open} className="rounded-md border-[1.5px] border-border-strong p-1.5"><Icon name="menu" className="h-5 w-5" /></button>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-overlay" />
          <aside className="absolute inset-y-0 start-0 w-72 border-e-[1.5px] border-border-strong bg-surface text-foreground" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} aria-label={S.menu} className="absolute end-2 top-2 rounded-md p-1.5 text-foreground hover:bg-background-muted"><Icon name="x" className="h-5 w-5" /></button>
            {body}
          </aside>
        </div>
      )}
    </>
  );
}
