"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import LogoutButton from "./LogoutButton";
import LangToggle from "../LangToggle";

type Item = { href: string; label: string; accent?: boolean };

export default function Sidebar({ t, lang, user, brandName, admin }: { t: AppDict; lang: Lang; user: { name: string; email: string; credits: number; plan: string }; brandName?: string; admin?: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  useEffect(() => { fetch("/api/notifications?count=1").then((r) => r.json()).then((j) => j.ok && setUnread(j.unread)).catch(() => {}); }, [path]);
  const base = `/${lang}/app`;
  const work: Item[] = [
    { href: `${base}/chat`, label: t.nav.chat, accent: true },
    { href: base, label: t.nav.inbox },
    { href: `${base}/calendar`, label: t.nav.calendar },
    { href: `${base}/files`, label: t.nav.files },
    { href: `${base}/tasks`, label: t.nav.tasks },
    { href: `${base}/inspo`, label: t.nav.inspo },
    { href: `${base}/generate`, label: t.nav.generate },
    { href: `${base}/reports`, label: t.nav.reports },
    { href: `${base}/notifications`, label: unread ? `${t.nav.notifications} (${unread})` : t.nav.notifications, accent: unread > 0 },
  ];
  const settings: Item[] = [
    { href: `${base}/onboarding`, label: t.nav.brand },
    { href: `${base}/governance`, label: t.nav.governance },
    { href: `${base}/integrations`, label: t.nav.integrations },
    { href: `${base}/billing`, label: t.nav.billing },
    { href: `${base}/refer`, label: t.nav.refer },
    { href: `${base}/mcp`, label: "MCP" },
    { href: `${base}/help`, label: lang === "ar" ? "المساعدة" : "Help" },
    ...(admin ? [{ href: `${base}/admin`, label: lang === "ar" ? "لوحة المؤسس" : "Founder console", accent: true }] : []),
  ];
  const active = (h: string) => (h === base ? path === base : path.startsWith(h));
  const Group = ({ title, items }: { title: string; items: Item[] }) => (
    <div>
      <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-mist-dim/70">{title}</p>
      <ul className="grid gap-0.5">
        {items.map((it) => (
          <li key={it.href}>
            <Link href={it.href} onClick={() => setOpen(false)} className={`block rounded-lg px-3 py-2 text-sm transition ${active(it.href) ? "bg-oasis text-mist" : it.accent ? "font-semibold text-saffron hover:bg-oasis/60" : "text-mist-dim hover:bg-oasis/60 hover:text-mist"}`}>
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
  const body = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link href={`${base}/chat`} className="font-display text-2xl font-bold text-mist">
        {t.appName}
        <span className="ms-2 inline-block h-2 w-2 rounded-full bg-saffron align-middle" aria-hidden />
      </Link>
      <Link href={`${base}/brands`} className="-mt-3 flex items-center justify-between rounded-lg border border-mist/15 px-3 py-2 text-xs text-mist-dim hover:border-mist/40 hover:text-mist">
        <span className="truncate" dir="auto">{brandName || (lang === "ar" ? "علامتك" : "Your brand")}</span>
        <span>⇄</span>
      </Link>
      <Group title={t.nav.workspace} items={work} />
      <Group title={t.nav.settings} items={settings} />
      <div className="mt-auto rounded-lg bg-oasis p-3 text-xs">
        <Link href={`${base}/profile`} className="block truncate font-medium text-mist hover:text-saffron">{user.name || user.email}</Link>
        <p className="mt-0.5 flex items-center justify-between text-mist-dim"><span>{user.plan}</span><Link href={`${base}/billing`} className="font-mono text-saffron" dir="ltr">{user.credits} {t.nav.credits}</Link></p>
        <div className="mt-2 flex items-center justify-between">
          <LangToggle lang={lang} size="sm" />
          <LogoutButton label={t.nav.logout} lang={lang} />
        </div>
      </div>
    </div>
  );
  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 bg-oasis-deep lg:block">{body}</aside>
      <header className="sticky top-0 z-40 flex items-center justify-between bg-oasis-deep px-4 py-3 text-mist lg:hidden">
        <Link href={`${base}/chat`} className="font-display text-xl font-bold">{t.appName}</Link>
        <div className="flex items-center gap-3">
          <Link href={`${base}/notifications`} aria-label={t.nav.notifications} className="relative text-base">🔔{unread > 0 && <span className="absolute -end-2 -top-1 rounded-full bg-sadu px-1 font-mono text-[10px] text-white" dir="ltr">{unread}</span>}</Link>
          <Link href={`${base}/billing`} className="font-mono text-xs text-saffron" dir="ltr">{user.credits}</Link>
          <LangToggle lang={lang} size="sm" />
          <button onClick={() => setOpen(!open)} aria-label={t.nav.menu} className="rounded-md border border-mist/20 px-2 py-1 text-sm">☰</button>
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 start-0 w-64 bg-oasis-deep" onClick={(e) => e.stopPropagation()}>{body}</aside>
        </div>
      )}
    </>
  );
}
