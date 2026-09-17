import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { listConversations, searchConversations } from "@/lib/conversations";
import { listTasks } from "@/lib/brand";

export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ q?: string }> }) {
  const { lang } = await params;
  const { q } = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const [convs, tasks] = await Promise.all([listConversations(sc(u)), listTasks(sc(u))]);
  const fromChat = tasks.filter((x) => x.source === "chat").length;
  const hits = q ? await searchConversations(sc(u), q) : null;
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{t.history.title}</h1>
      <p className="mt-2 text-ink/70">{t.history.sub}</p>
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="card"><p className="text-xs text-ink/50">{t.history.conversations}</p><p className="page-title" dir="ltr">{convs.length + 1}</p></div>
        <div className="card"><p className="text-xs text-ink/50">{t.history.tasks}</p><p className="page-title" dir="ltr">{fromChat}</p></div>
      </div>
      {hits && (
        <div className="mt-6 card">
          <p className="text-xs text-ink/50">“{q}” · {hits.length}</p>
          <ul className="mt-2 divide-y divide-ink/10">{hits.map((h, i) => <li key={i} className="py-2 text-sm"><Link href={`/${lang}/app/chat?conv=${h.conversationId}`} className="font-medium hover:text-oasis" dir="auto">{h.title}</Link><p className="text-xs text-ink/60" dir="auto">…{h.snippet}…</p></li>)}</ul>
        </div>
      )}
      <ul className="mt-6 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
        <li className="flex items-center justify-between px-4 py-3 text-sm"><Link href={`/${lang}/app/chat`} className="font-medium hover:text-oasis">{t.history.gettingStarted}</Link><span className="text-xs text-ink/50">{t.agents.noor.name}</span></li>
        {convs.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <Link href={`/${lang}/app/chat?conv=${c.id}`} className="min-w-0 truncate font-medium hover:text-oasis" dir="auto">{c.title || "…"}</Link>
            <span className="shrink-0 text-xs text-ink/50">{t.agents[c.agent ?? "noor"].name} · <span dir="ltr">{c.count}</span> · <span className="font-mono" dir="ltr">{c.updatedAt.slice(0, 10)}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
