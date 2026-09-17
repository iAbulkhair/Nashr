"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import { AGENTS, type AgentId } from "@/lib/agents";
import LogoutButton from "./LogoutButton";
import LangToggle from "../LangToggle";

type Conv = { id: string; title: string; agent?: AgentId; updatedAt: string };

/**
 * Enrich-style workspace sidebar: brand header, # channels, direct messages with
 * one thread per agent, chat history with search, workspace links, user menu.
 */
export default function Sidebar({ t, lang, user, brandName, admin, supportWa }: { t: AppDict; lang: Lang; user: { name: string; email: string; credits: number; plan: string }; brandName?: string; admin?: boolean; supportWa?: string }) {
  const path = usePathname();
  const r = useRouter();
  const base = `/${lang}/app`;
  const N = t.nav;
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [unread, setUnread] = useState(0);
  const [pending, setPending] = useState(0);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    fetch("/api/notifications?count=1").then((x) => x.json()).then((j) => j.ok && setUnread(j.unread)).catch(() => {});
    fetch("/api/tasks").then((x) => x.json()).then((j) => j.ok && setPending((j.tasks as { status: string }[]).filter((x) => x.status === "pending").length)).catch(() => {});
    fetch("/api/conversations").then((x) => x.json()).then((j) => j.ok && setConvs(j.conversations)).catch(() => {});
  }, [path]);
  async function newThread(agent: AgentId) {
    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent }) })).json();
    if (j.ok) { setOpen(false); r.push(`${base}/chat?conv=${j.conversation.id}`); }
  }
  const active = (h: string) => (h === base ? path === base : path.startsWith(h.split("?")[0]) && !h.includes("?"));
  const row = (href: string, label: React.ReactNode, opts: { badge?: number; hash?: boolean; icon?: string } = {}) => (
    <Link href={href} onClick={() => setOpen(false)} className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm transition ${active(href) ? "bg-oasis text-mist" : "text-mist-dim hover:bg-oasis/60 hover:text-mist"}`}>
      <span className="clip flex items-center gap-2">{opts.hash && <span className="text-mist-dim/60">#</span>}{opts.icon && <span aria-hidden>{opts.icon}</span>}{label}</span>
      {opts.badge ? <span className="rounded-full bg-saffron px-1.5 font-mono text-[10px] text-ink" dir="ltr">{opts.badge}</span> : null}
    </Link>
  );
  const head = (title: string) => <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-mist-dim/70">{title}</p>;
  const initial = (brandName || t.appName).trim().charAt(0);

  const body = (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <Link href={`${base}/brands`} className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-oasis/60">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-saffron font-display text-lg font-bold text-ink" aria-hidden>{initial}</span>
        <span className="min-w-0"><span className="clip block text-sm font-semibold text-mist" dir="auto">{brandName || (lang === "ar" ? "علامتك" : "Your brand")}</span><span className="block text-[10px] text-mist-dim">{N.workspace}</span></span>
      </Link>

      <div>
        {head(N.channels)}
        <ul className="grid gap-0.5">
          <li>{row(`${base}/chat`, N.main, { hash: true })}</li>
          <li>{row(base, N.approvals, { hash: true, badge: pending })}</li>
          <li>{row(`${base}/inspo`, N.contentInspo, { hash: true })}</li>
          <li>{row(`${base}/reports`, N.performance, { hash: true })}</li>
          <li>{row(`${base}/calendar`, N.calendarCh, { hash: true })}</li>
        </ul>
      </div>

      <div>
        {head(N.dms)}
        <ul className="grid gap-0.5">
          {AGENTS.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm text-mist-dim hover:bg-oasis/60">
              <Link href={a.id === "noor" ? `${base}/chat` : `${base}/chat?agent=${a.id}`} onClick={() => setOpen(false)} className="flex min-w-0 items-center gap-2 hover:text-mist">
                <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-oasis font-display text-xs font-bold text-saffron">{t.agents[a.id].name.charAt(0)}<span className="absolute -end-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-oasis-deep bg-green-400" aria-hidden /></span>
                <span className="min-w-0"><span className="clip block text-mist">{t.agents[a.id].name}</span><span className="clip block text-[10px]">{t.agents[a.id].role}</span></span>
              </Link>
              <button onClick={() => newThread(a.id)} className="rounded-full bg-saffron/15 px-2 py-0.5 text-[10px] font-semibold text-saffron hover:bg-saffron hover:text-ink">+ {N.newConv}</button>
            </li>
          ))}
        </ul>
      </div>

      <div>
        {head(N.history)}
        <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) { setOpen(false); r.push(`${base}/conversations?q=${encodeURIComponent(q.trim())}`); } }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={N.searchConv} className="w-full rounded-lg border border-mist/15 bg-oasis/40 px-3 py-1.5 text-xs text-mist placeholder:text-mist-dim focus:border-saffron focus:outline-none" />
        </form>
        <ul className="mt-1 grid gap-0.5">
          <li>{row(`${base}/chat`, N.gettingStarted, { icon: "💬" })}</li>
          {convs.slice(0, 3).map((c) => <li key={c.id}>{row(`${base}/chat?conv=${c.id}`, <span dir="auto" className="clip">{c.title || "…"}</span>, { icon: "💬" })}</li>)}
          <li><Link href={`${base}/conversations`} onClick={() => setOpen(false)} className="block px-3 py-1 text-xs text-mist-dim hover:text-mist">▾ {N.seeAll}</Link></li>
        </ul>
      </div>

      <div className="border-t border-mist/10 pt-3">
        <ul className="grid gap-0.5">
          <li>{row(`${base}/files`, N.files, { icon: "🗂" })}</li>
          <li>{row(`${base}/refer`, N.refer, { icon: "🎁" })}</li>
          <li>{row(`${base}/governance`, <>{N.governance} <span className="ms-1 rounded bg-saffron px-1 text-[9px] font-bold text-ink">NEW</span></>, { icon: "🛡" })}</li>
          <li>{row(`${base}/integrations`, N.integrations, { icon: "▦" })}</li>
          <li><a href={supportWa ? `https://wa.me/${supportWa}` : `${base}/help#support`} target={supportWa ? "_blank" : undefined} rel="noreferrer" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-mist-dim hover:bg-oasis/60 hover:text-mist"><span aria-hidden>💬</span>{N.contact}</a></li>
        </ul>
      </div>

      <div className="relative mt-auto border-t border-mist/10 pt-3">
        <button onClick={() => setMenu(!menu)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs text-mist hover:bg-oasis/60" aria-expanded={menu}>
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-mist/15 font-semibold">{(user.name || user.email).charAt(0).toUpperCase()}</span>
          <span className="min-w-0 flex-1"><span className="clip block" dir="ltr">{user.email}</span><span className="block text-[10px] text-mist-dim">{user.plan} · <span className="font-mono text-saffron" dir="ltr">{user.credits} {N.credits}</span></span></span>
          <span className="text-mist-dim">{menu ? "▴" : "▾"}</span>
        </button>
        {menu && (
          <div className="absolute inset-x-0 bottom-full mb-1 rounded-xl border border-mist/15 bg-oasis p-2 text-sm shadow-xl">
            <ul className="grid gap-0.5">
              {[
                [`${base}/profile`, N.profile], [`${base}/notifications`, unread ? `${N.notifications} (${unread})` : N.notifications], [`${base}/tasks`, N.tasks], [`${base}/generate`, N.generate], [`${base}/billing`, N.billing], [`${base}/onboarding`, N.brand], [`${base}/brands`, N.brands], [`${base}/mcp`, "MCP"], [`${base}/help`, N.help],
                ...(admin ? [[`${base}/admin`, N.founder]] : []),
              ].map(([h, l]) => <li key={h}><Link href={h} onClick={() => { setMenu(false); setOpen(false); }} className="block rounded-lg px-3 py-1.5 text-mist-dim hover:bg-oasis-deep hover:text-mist">{l}</Link></li>)}
            </ul>
            <div className="mt-2 flex items-center justify-between border-t border-mist/10 px-2 pt-2">
              <LangToggle lang={lang} size="sm" />
              <LogoutButton label={N.logout} lang={lang} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 bg-oasis-deep lg:block">{body}</aside>
      <header className="sticky top-0 z-40 flex items-center justify-between bg-oasis-deep px-4 py-3 text-mist lg:hidden">
        <Link href={`${base}/chat`} className="font-display text-xl font-bold">{t.appName}</Link>
        <div className="flex items-center gap-3">
          <Link href={`${base}/notifications`} aria-label={N.notifications} className="relative text-base">🔔{unread > 0 && <span className="absolute -end-2 -top-1 rounded-full bg-sadu px-1 font-mono text-[10px] text-white" dir="ltr">{unread}</span>}</Link>
          <Link href={`${base}/billing`} className="font-mono text-xs text-saffron" dir="ltr">{user.credits}</Link>
          <LangToggle lang={lang} size="sm" />
          <button onClick={() => setOpen(!open)} aria-label={N.menu} className="rounded-md border border-mist/20 px-2 py-1 text-sm">☰</button>
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 start-0 w-72 bg-oasis-deep" onClick={(e) => e.stopPropagation()}>{body}</aside>
        </div>
      )}
    </>
  );
}
