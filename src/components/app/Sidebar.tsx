"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import LogoutButton from "./LogoutButton";

type Item = { href: string; label: string; accent?: boolean };

export default function Sidebar({ t, lang, user }: { t: AppDict; lang: Lang; user: { name: string; email: string; credits: number; plan: string } }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const base = `/${lang}/app`;
  const work: Item[] = [
    { href: `${base}/chat`, label: t.nav.chat, accent: true },
    { href: base, label: t.nav.inbox },
    { href: `${base}/calendar`, label: t.nav.calendar },
    { href: `${base}/files`, label: t.nav.files },
    { href: `${base}/tasks`, label: t.nav.tasks },
    { href: `${base}/inspo`, label: t.nav.inspo },
    { href: `${base}/generate`, label: t.nav.generate },
  ];
  const settings: Item[] = [
    { href: `${base}/onboarding`, label: t.nav.brand },
    { href: `${base}/governance`, label: t.nav.governance },
    { href: `${base}/integrations`, label: t.nav.integrations },
    { href: `${base}/billing`, label: t.nav.billing },
    { href: `${base}/refer`, label: t.nav.refer },
    { href: `${base}/mcp`, label: "MCP" },
    { href: `${base}/help`, label: lang === "ar" ? "المساعدة" : "Help" },
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
      <Group title={t.nav.workspace} items={work} />
      <Group title={t.nav.settings} items={settings} />
      <div className="mt-auto rounded-lg bg-oasis p-3 text-xs">
        <p className="truncate font-medium text-mist">{user.name || user.email}</p>
        <p className="mt-0.5 flex items-center justify-between text-mist-dim"><span>{user.plan}</span><Link href={`${base}/billing`} className="font-mono text-saffron" dir="ltr">{user.credits} {t.nav.credits}</Link></p>
        <div className="mt-2 flex items-center justify-between">
          <Link href={lang === "ar" ? path.replace("/ar/", "/en/") : path.replace("/en/", "/ar/")} className="text-mist-dim hover:text-mist">{lang === "ar" ? "English" : "العربية"}</Link>
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
          <Link href={`${base}/billing`} className="font-mono text-xs text-saffron" dir="ltr">{user.credits}</Link>
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
