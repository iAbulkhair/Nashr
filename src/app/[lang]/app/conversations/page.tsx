import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { listConversations } from "@/lib/conversations";
import { listTasks } from "@/lib/brand";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const [convs, tasks] = await Promise.all([listConversations(sc(u)), listTasks(sc(u))]);
  const fromChat = tasks.filter((x) => x.source === "chat").length;
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{t.history.title}</h1>
      <p className="mt-2 text-ink/70">{t.history.sub}</p>
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="card"><p className="text-xs text-ink/50">{t.history.conversations}</p><p className="page-title" dir="ltr">{convs.length + 1}</p></div>
        <div className="card"><p className="text-xs text-ink/50">{t.history.tasks}</p><p className="page-title" dir="ltr">{fromChat}</p></div>
      </div>
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
