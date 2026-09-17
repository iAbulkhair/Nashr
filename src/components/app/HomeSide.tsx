import Link from "next/link";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Kpis } from "@/lib/stats";

type Props = {
  t: AppDict; lang: Lang; k: Kpis;
  connections: { provider: string }[];
  schedule: { weeklyPlan: boolean; dailyBrief: boolean; followUps: boolean; lastWeekly?: string; lastDaily?: string };
  files: { name: string; updatedAt: string }[];
};


function Box({ title, children, href, action }: { title: string; children: React.ReactNode; href?: string; action?: string }) {
  return (
    <section className="card card-sm">
      <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{title}</h3>{href && action && <Link href={href} className="text-xs text-oasis hover:underline">{action}</Link>}</div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Right-hand home panel (Enrich-style): metrics, channels, task feed, brand assets. Server component. */
export default function HomeSide({ t, lang, k, connections, schedule, files }: Props) {
  const H = t.home;
  const base = `/${lang}/app`;
  const week = k.weeks[k.weeks.length - 1] ?? { created: 0, approved: 0 };
  const tiles = [
    { l: H.created7, v: week.created, href: base },
    { l: H.approved7, v: week.approved, href: base },
    { l: H.pending, v: k.pending, href: base },
  ];
  const tasks = [
    { on: schedule.weeklyPlan, l: t.tasks.weekly, when: H.sunday, last: schedule.lastWeekly },
    { on: schedule.dailyBrief, l: t.tasks.daily, when: H.daily8, last: schedule.lastDaily },
    { on: schedule.followUps !== false, l: t.tasks.followups, when: H.daily8 },
  ];
  return (
    <aside className="grid content-start gap-4">
      <Box title={H.metrics} href={`${base}/reports`} action={H.all}>
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((x) => <Link key={x.l} href={x.href} className="rounded-lg bg-salt-dim p-2"><p className="text-[10px] text-ink/50">{x.l}</p><p className="font-display text-xl font-bold text-oasis" dir="ltr">{x.v}</p></Link>)}
        </div>
        <Link href={`${base}/integrations`} className="mt-3 block rounded-lg border border-dashed border-ink/20 p-2 text-center text-xs text-ink/60 hover:border-oasis hover:text-oasis">{H.connectAnalytics}</Link>
      </Box>
      <Box title={H.channels} href={`${base}/integrations`} action={H.addChannel}>
        {connections.length === 0 ? <p className="text-xs text-ink/50">{H.noChannels}</p> : (
          <ul className="flex flex-wrap gap-1.5">{connections.map((c) => <li key={c.provider} className="badge badge-primary">{c.provider}</li>)}</ul>
        )}
      </Box>
      <Box title={H.taskFeed} href={`${base}/tasks`} action={H.manage}>
        <ul className="space-y-2">
          {tasks.map((x) => (
            <li key={x.l} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${x.on ? "bg-oasis" : "bg-ink/20"}`} />{x.l}</span>
              <span className="font-mono text-[10px] text-ink/50" dir="ltr">{x.last ? x.last.slice(5, 10) : x.when}</span>
            </li>
          ))}
        </ul>
      </Box>
      <Box title={H.assets} href={`${base}/files`} action={H.all}>
        {files.length === 0 ? <p className="text-xs text-ink/50">{H.noFiles}</p> : (
          <ul className="space-y-1.5">{files.slice(0, 4).map((f) => <li key={f.name} className="flex items-center justify-between text-xs"><Link href={`${base}/files`} className="truncate hover:text-oasis" dir="ltr">{f.name}</Link><span className="font-mono text-[10px] text-ink/50" dir="ltr">{f.updatedAt.slice(5, 10)}</span></li>)}</ul>
        )}
        <Link href={`${base}/onboarding`} className="mt-3 block rounded-lg border border-dashed border-ink/20 p-2 text-center text-xs text-ink/60 hover:border-oasis hover:text-oasis">{H.completeBrand}</Link>
      </Box>
    </aside>
  );
}
