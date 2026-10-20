import { appScreenMeta } from "@/lib/screen-titles";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { listConversations, searchConversations } from "@/lib/conversations";
import { listLite } from "@/lib/brand";
import { kpiSince } from "@/lib/stats";
import Scribble from "@/components/Scribble";
import { appHref } from "@/lib/app-href";

export const dynamic = "force-dynamic";

export const generateMetadata = appScreenMeta("conversations");

export default async function Page({ params, searchParams }: PageProps<"/[lang]/app/b/[brand]/conversations">) {
  const { lang } = await params;
  // A query key can repeat: "?q=a&q=b" reaches a page as ["a", "b"], and searchConversations calls q.trim().
  // Typing it as `string` hid that from the compiler and the page answered 500. Anything but a single string is
  // treated as no query, which is what "?q=" already does.
  const { q: rawQ } = await searchParams;
  const q = typeof rawQ === "string" ? rawQ : undefined;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  const t = appDict[lang];
  // Bounded to the same 90-day window every other KPI on the site uses. Unbounded, this read pulled every task the
  // workspace had ever created — every month of the light index, megabytes over HTTP — to render a single integer.
  // The tile says "(90 days)" in both languages so the number still means what it says.
  const [convs, tasks] = await Promise.all([listConversations(sc(u)), listLite(sc(u), kpiSince())]);
  const fromChat = tasks.filter((x) => x.source === "chat").length;
  const hits = q ? await searchConversations(sc(u), q) : null;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="conversations-t1" />{t.history.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{t.history.sub}</p>
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="card"><p className="text-xs text-foreground-muted">{t.history.conversations}</p><p className="page-title" dir="ltr">{convs.length + 1}</p></div>
        <div className="card"><p className="text-xs text-foreground-muted">{t.history.tasks}</p><p className="page-title" dir="ltr">{fromChat}</p></div>
      </div>
      {hits && (
        <div className="mt-6 card">
          <p className="text-xs text-foreground-muted">“{q}” · {hits.length}</p>
          <ul className="mt-2 divide-y divide-foreground/10">{hits.map((h, i) => <li key={i} className="py-2 text-sm"><Link href={`/${lang}/app/chat?conv=${h.conversationId}`} className="font-medium hover:text-foreground" dir="auto">{h.title}</Link><p className="text-xs text-foreground-muted" dir="auto">…{h.snippet}…</p></li>)}</ul>
        </div>
      )}
      <ul className="mt-6 divide-y divide-foreground/10 rounded-xl border border-foreground/10 bg-surface">
        <li className="flex items-center justify-between px-4 py-3 text-sm"><Link href={`/${lang}/app/chat`} className="font-medium hover:text-foreground">{t.history.gettingStarted}</Link><span className="text-xs text-foreground-muted">{t.agents.noor.name}</span></li>
        {convs.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <Link href={`/${lang}/app/chat?conv=${c.id}`} className="min-w-0 truncate font-medium hover:text-foreground" dir="auto">{c.title || "…"}</Link>
            <span className="shrink-0 text-xs text-foreground-muted">{t.agents[c.agent ?? "noor"].name} · <span dir="ltr">{c.count}</span> · <span className="font-mono" dir="ltr">{c.updatedAt.slice(0, 10)}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
