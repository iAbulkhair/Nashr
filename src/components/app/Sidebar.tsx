"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Role } from "@/lib/auth";
import { AGENTS, type AgentId } from "@/lib/agents";
import LogoutButton from "./LogoutButton";
import LangToggle from "../LangToggle";
import { Icon, type IconName } from "./Icons";

type Conv = { id: string; title: string; agent?: AgentId; updatedAt: string };

/**
 * Workspace sidebar. Noor is the one visible door; the specialists (every other agent) sit behind
 * one disclosure. Text floor 12px. No decorative badges except the localized "new" and the acting person's role.
 *
 * `user` is who is ACTING (a member sees their own name, email and role); plan and credits are the account's.
 * `show` hides owner-only entries (referrals, MCP) from other roles: display only, the routes enforce the same rules.
 */
export default function Sidebar({ t, lang, user, show, brandName, admin, supportWa }: { t: AppDict; lang: Lang; user: { name: string; email: string; role: Role; credits: number; plan: string }; show: { owner: boolean; refer: boolean; mcp: boolean }; brandName?: string; admin?: boolean; supportWa?: string }) {
  const path = usePathname();
  const r = useRouter();
  const base = `/${lang}/app`;
  const N = t.nav;
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [team, setTeam] = useState(false);
  const [unread, setUnread] = useState(0);
  const [pending, setPending] = useState(0);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    fetch("/api/notifications?count=1").then((x) => x.json()).then((j) => j.ok && setUnread(j.unread)).catch(() => {});
    // Only the number: the full list (up to 200 task bodies) was downloaded on every navigation for this badge.
    const loadPending = () => fetch("/api/tasks?count=pending").then((x) => x.json()).then((j) => j.ok && setPending(j.pending)).catch(() => {});
    void loadPending();
    window.addEventListener("nashr:pending-changed", loadPending);
    fetch("/api/conversations").then((x) => x.json()).then((j) => j.ok && setConvs(j.conversations)).catch(() => {});
    return () => window.removeEventListener("nashr:pending-changed", loadPending);
  }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setMenu(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  async function newThread(agent: AgentId) {
    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent }) })).json();
    if (j.ok) { setOpen(false); r.push(`${base}/chat?conv=${j.conversation.id}`); }
  }
  const active = (h: string) => (h === base ? path === base : !h.includes("?") && path.startsWith(h));
  const row = (href: string, label: React.ReactNode, icon: IconName, badge?: number) => (
    <Link href={href} onClick={() => setOpen(false)} className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition ${active(href) ? "bg-oasis text-mist" : "text-mist-dim hover:bg-oasis/60 hover:text-mist"}`}>
      <span className="flex min-w-0 items-center gap-2.5"><Icon name={icon} className="h-4 w-4 shrink-0 opacity-80" /><span className="clip">{label}</span></span>
      {badge ? <span className="tnum rounded-full bg-saffron px-2 text-xs font-semibold text-ink" dir="ltr">{badge}</span> : null}
    </Link>
  );
  const head = (title: string) => <p className="mb-1 px-3 text-xs font-semibold text-mist-dim">{title}</p>;
  const initial = (brandName || t.appName).trim().charAt(0);
  const specialists = AGENTS.filter((a) => a.id !== "noor");
  const planName = (N.plans as Record<string, string>)[user.plan] ?? user.plan;

  const body = (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <div>
        <Link href={`${base}/brands`} className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-oasis/60">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-saffron font-display text-lg font-bold text-ink" aria-hidden>{initial}</span>
          <span className="min-w-0"><span className="clip block text-sm font-semibold text-mist" dir="auto">{brandName || (lang === "ar" ? "علامتك" : "Your brand")}</span><span className="block text-xs text-mist-dim">{N.workspace}</span></span>
        </Link>
        <div className="sadu-thin mt-3 rounded-full opacity-90" aria-hidden />
      </div>

      <div>
        {head(N.channels)}
        <ul className="grid gap-0.5">
          <li>{row(`${base}/chat`, N.main, "chat")}</li>
          <li>{row(base, N.approvals, "inbox", pending)}</li>
          <li>{row(`${base}/todo`, N.todo, "check")}</li>
          <li>{row(`${base}/calendar`, N.calendarCh, "calendar")}</li>
          <li>{row(`${base}/reports`, N.performance, "chart")}</li>
          <li>{row(`${base}/inspo`, N.contentInspo, "spark")}</li>
        </ul>
      </div>

      <div>
        {head(N.dms)}
        <ul className="grid gap-0.5">
          <li className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-mist-dim hover:bg-oasis/60">
            <Link href={`${base}/chat`} onClick={() => setOpen(false)} className="flex min-w-0 items-center gap-2.5 hover:text-mist">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-saffron font-display text-xs font-bold text-ink">{t.agents.noor.name.charAt(0)}</span>
              <span className="min-w-0"><span className="clip block text-mist">{t.agents.noor.name}</span><span className="clip block text-xs">{t.agents.noor.role}</span></span>
            </Link>
            <button onClick={() => newThread("noor")} className="btn btn-accent btn-xs" aria-label={`${N.newConv}: ${t.agents.noor.name}`}>+ {N.newConv}</button>
          </li>
          <li>
            <button onClick={() => setTeam(!team)} aria-expanded={team} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-mist-dim hover:bg-oasis/60 hover:text-mist">
              <span className="flex items-center gap-2.5"><span className="flex -space-x-2 rtl:space-x-reverse">{specialists.slice(0, 3).map((a) => <span key={a.id} className="grid h-6 w-6 place-items-center rounded-full border border-oasis-deep bg-oasis text-xs font-bold text-saffron">{t.agents[a.id].name.charAt(0)}</span>)}</span>{N.specialists} <span className="tnum text-xs" dir="ltr">({specialists.length})</span></span>
              <Icon name="chevron" className={`h-4 w-4 transition ${team ? "rotate-180" : ""}`} />
            </button>
            {team && (
              <ul className="ms-3 mt-1 grid gap-0.5 border-s border-mist/10 ps-2">
                {specialists.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-mist-dim hover:bg-oasis/60">
                    <Link href={`${base}/chat?agent=${a.id}`} onClick={() => setOpen(false)} className="flex min-w-0 items-center gap-2 hover:text-mist">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-oasis text-xs font-bold text-saffron">{t.agents[a.id].name.charAt(0)}</span>
                      <span className="min-w-0"><span className="clip block text-mist">{t.agents[a.id].name}</span><span className="clip block text-xs">{t.agents[a.id].role}</span></span>
                    </Link>
                    <button onClick={() => newThread(a.id)} className="text-xs font-semibold text-saffron hover:underline" aria-label={`${N.newConv}: ${t.agents[a.id].name}`}>+</button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        </ul>
      </div>

      <div>
        {head(N.history)}
        <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) { setOpen(false); r.push(`${base}/conversations?q=${encodeURIComponent(q.trim())}`); } }} className="relative">
          <Icon name="search" className="pointer-events-none absolute start-2.5 top-2 h-4 w-4 text-mist-dim" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={N.searchConv} aria-label={N.searchConv} className="w-full rounded-lg border border-mist/15 bg-oasis/40 py-1.5 pe-3 ps-8 text-sm text-mist placeholder:text-mist-dim focus:border-saffron focus:outline-none" />
        </form>
        <ul className="mt-1 grid gap-0.5">
          {convs.slice(0, 3).map((c) => <li key={c.id}>{row(`${base}/chat?conv=${c.id}`, <span dir="auto">{c.title || "…"}</span>, "chat")}</li>)}
          <li><Link href={`${base}/conversations`} onClick={() => setOpen(false)} className="block px-3 py-1 text-xs text-mist-dim hover:text-mist">{N.seeAll}</Link></li>
        </ul>
      </div>

      <div className="border-t border-mist/10 pt-3">
        <ul className="grid gap-0.5">
          <li>{row(`${base}/files`, N.files, "folder")}</li>
          <li>{row(`${base}/team`, N.members, "users")}</li>
          {show.refer && <li>{row(`${base}/refer`, N.refer, "gift")}</li>}
          <li>{row(`${base}/governance`, N.governance, "shield")}</li>
          <li>{row(`${base}/activity`, N.activity, "clock")}</li>
          <li>{row(`${base}/integrations`, N.integrations, "grid")}</li>
          {/* Public page: what shipped, and the wishlist signed-in owners vote on. */}
          <li>{row(`/${lang}/updates`, N.updates, "sapling")}</li>
          {/* Founder accounts only: platform console (users, usage, billing, quality, audit log). */}
          {admin && <li>{row(`${base}/admin`, N.founder, "dashboard")}</li>}
          <li><a href={supportWa ? `https://wa.me/${supportWa}` : `${base}/help#support`} target={supportWa ? "_blank" : undefined} rel="noreferrer" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-mist-dim hover:bg-oasis/60 hover:text-mist"><Icon name="whatsapp" className="h-4 w-4 opacity-80" />{N.contact}</a></li>
        </ul>
      </div>

      <div className="relative mt-auto border-t border-mist/10 pt-3">
        <button onClick={() => setMenu(!menu)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm text-mist hover:bg-oasis/60" aria-expanded={menu} aria-haspopup="menu">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-mist/15 font-semibold">{(user.name || user.email).charAt(0).toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5"><span className="clip" dir="auto">{user.name || user.email}</span><span className="shrink-0 rounded-full bg-mist/15 px-1.5 text-xs text-mist-dim">{t.team.roles[user.role]}</span></span>
            <span className="clip block text-xs text-mist-dim" dir="ltr">{user.email}</span>
            <span className="block text-xs text-mist-dim" title={show.owner ? undefined : N.sharedCredits}>{planName} · <span className="tnum text-saffron">{user.credits} {N.credits}</span></span>
          </span>
          <Icon name="chevron" className={`h-4 w-4 text-mist-dim transition ${menu ? "rotate-180" : ""}`} />
        </button>
        {menu && (
          <div role="menu" className="absolute inset-x-0 bottom-full mb-1 rounded-xl border border-mist/15 bg-oasis p-2 text-sm shadow-xl">
            <ul className="grid gap-0.5">
              {[
                [`${base}/profile`, N.profile], [`${base}/notifications`, unread ? `${N.notifications} (${unread})` : N.notifications], [`${base}/tasks`, N.tasks], [`${base}/generate`, N.generate], [`${base}/billing`, N.billing], [`${base}/onboarding`, N.brand], [`${base}/brands`, N.brands], [`${base}/team`, N.members],
                ...(show.mcp ? [[`${base}/mcp`, "MCP"]] : []), [`${base}/help`, N.help],
                ...(admin ? [[`${base}/admin`, N.founder]] : []),
              ].map(([h, l]) => <li key={h}><Link role="menuitem" href={h} onClick={() => { setMenu(false); setOpen(false); }} className="block rounded-lg px-3 py-1.5 text-mist-dim hover:bg-oasis-deep hover:text-mist">{l}</Link></li>)}
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
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 bg-oasis-deep lg:block">{body}</aside>
      <header className="sticky top-0 z-40 flex items-center justify-between bg-oasis-deep px-4 py-3 text-mist lg:hidden">
        <Link href={`${base}/chat`} className="font-display text-xl font-bold">{t.appName}</Link>
        <div className="flex items-center gap-3">
          <Link href={`${base}/notifications`} aria-label={N.notifications} className="relative text-mist"><Icon name="bell" className="h-5 w-5" />{unread > 0 && <span className="tnum absolute -end-2 -top-1.5 rounded-full bg-sadu px-1.5 text-xs font-semibold text-white" dir="ltr">{unread}</span>}</Link>
          <Link href={`${base}/billing`} title={show.owner ? undefined : N.sharedCredits} className="tnum text-xs text-saffron">{user.credits} {N.credits}</Link>
          <button onClick={() => setOpen(!open)} aria-label={N.menu} aria-expanded={open} className="rounded-md border border-mist/20 p-1.5"><Icon name="menu" className="h-5 w-5" /></button>
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 start-0 w-72 bg-oasis-deep" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} aria-label={N.menu} className="absolute end-2 top-2 rounded-md p-1.5 text-mist hover:bg-oasis"><Icon name="x" className="h-5 w-5" /></button>
            {body}
          </aside>
        </div>
      )}
    </>
  );
}
