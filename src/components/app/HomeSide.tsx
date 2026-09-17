import Link from "next/link";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Kpis } from "@/lib/stats";
import type { Notif } from "@/lib/notifications";

type Props = {
  t: AppDict; lang: Lang; k: Kpis;
  connections: { provider: string }[];
  schedule: { weeklyPlan: boolean; dailyBrief: boolean; followUps: boolean; lastWeekly?: string; lastDaily?: string };
  files: { name: string; updatedAt: string }[];
  brief?: string | null;
  action?: Notif | null;
};

function Box({ title, children, href, action }: { title: string; children: React.ReactNode; href?: string; action?: string }) {
  return (
    <section className="card card-sm">
      <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{title}</h3>{href && action && <Link href={href} className="text-xs text-oasis hover:underline">{action}</Link>}</div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Next Sunday 03:00 UTC (weekly) or next 05:00 UTC (daily), as "in Nd" / "in Nh". */
function nextRun(kind: "weekly" | "daily", lang: Lang) {
  const now = new Date();
  const n = new Date(now);
  if (kind === "weekly") { n.setUTCHours(3, 0, 0, 0); n.setUTCDate(n.getUTCDate() + ((7 - n.getUTCDay()) % 7 || (n <= now ? 7 : 0))); if (n <= now) n.setUTCDate(n.getUTCDate() + 7); }
  else { n.setUTCHours(5, 0, 0, 0); if (n <= now) n.setUTCDate(n.getUTCDate() + 1); }
  const h = Math.max(1, Math.round((n.getTime() - now.getTime()) / 36e5));
  return h >= 24 ? (lang === "ar" ? `بعد ${Math.round(h / 24)} يوم` : `in ${Math.round(h / 24)}d`) : (lang === "ar" ? `بعد ${h} ساعة` : `in ${h}h`);
}
function ago(iso: string | undefined, lang: Lang) {
  if (!iso) return lang === "ar" ? "لم يُشغَّل بعد" : "never";
  const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 36e5));
  return h >= 48 ? (lang === "ar" ? `قبل ${Math.round(h / 24)} يوم` : `${Math.round(h / 24)}d ago`) : (lang === "ar" ? `قبل ${h} ساعة` : `${h}h ago`);
}

/** Right-hand home panel (Enrich-style): metrics, channels, task feed with live status and latest run, brand assets. Server component. */
export default function HomeSide({ t, lang, k, connections, schedule, files, brief, action }: Props) {
  const H = t.home;
  const base = `/${lang}/app`;
  const week = k.weeks[k.weeks.length - 1] ?? { created: 0, approved: 0 };
  const tiles = [
    { l: H.created7, v: week.created, href: base },
    { l: H.approved7, v: week.approved, href: base },
    { l: H.pending, v: k.pending, href: base },
  ];
  const tasks = [
    { on: schedule.weeklyPlan, l: t.tasks.weekly, next: nextRun("weekly", lang), last: ago(schedule.lastWeekly, lang) },
    { on: schedule.dailyBrief, l: t.tasks.daily, next: nextRun("daily", lang), last: ago(schedule.lastDaily, lang) },
    { on: schedule.followUps !== false, l: t.tasks.followups, next: nextRun("daily", lang), last: ago(schedule.lastDaily, lang) },
  ];
  const briefLines = (brief ?? "").split("\n").filter(Boolean).slice(0, 4);
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
            <li key={x.l} className="text-xs">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-medium"><span className={`h-1.5 w-1.5 rounded-full ${x.on ? "bg-oasis" : "bg-ink/20"}`} />{x.l}</span>
                <Link href={`${base}/tasks`} className="text-oasis hover:underline">{H.runNow}</Link>
              </div>
              <p className="ms-3.5 text-[10px] text-ink/50">{x.on ? H.live : H.paused} · {H.next} {x.next} · {H.last} {x.last}</p>
            </li>
          ))}
        </ul>
        {briefLines.length > 0 && (
          <div className="mt-3 rounded-lg bg-salt-dim p-3 text-xs">
            <p className="font-semibold">{H.latestRun}</p>
            {briefLines.map((l, i) => <p key={i} className="mt-1 text-ink/70" dir="auto">{l}</p>)}
          </div>
        )}
        {action && (
          <div className="mt-3 rounded-lg border border-saffron/50 bg-saffron/10 p-3 text-xs">
            <p className="font-semibold" dir="auto">⚡ {action.title}</p>
            <p className="mt-1 text-ink/70" dir="auto">{action.body}</p>
            <Link href={action.href} className="btn btn-primary btn-xs mt-2">{H.review}</Link>
          </div>
        )}
      </Box>
      <Box title={H.assets} href={`${base}/files`} action={H.all}>
        {files.length === 0 ? <p className="text-xs text-ink/50">{H.noFiles}</p> : (
          <ul className="space-y-1.5">{files.slice(0, 4).map((f) => <li key={f.name} className="flex items-center justify-between text-xs"><Link href={`${base}/files`} className="hover:text-oasis" dir="ltr">{f.name}</Link><span className="font-mono text-[10px] text-ink/50" dir="ltr">{f.updatedAt.slice(5, 10)}</span></li>)}</ul>
        )}
        <Link href={`${base}/onboarding`} className="mt-3 block rounded-lg border border-dashed border-ink/20 p-2 text-center text-xs text-ink/60 hover:border-oasis hover:text-oasis">{H.completeBrand}</Link>
      </Box>
    </aside>
  );
}
