import Link from "next/link";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Kpis } from "@/lib/stats";
import type { Notif } from "@/lib/notifications";
import { Icon } from "./Icons";

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
      <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{title}</h3>{href && action && <Link href={href} className="text-xs text-foreground hover:underline">{action}</Link>}</div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Arabic plural forms for days and hours. */
const daysAr = (n: number) => (n === 1 ? "يوم" : n === 2 ? "يومين" : n <= 10 ? `${n} أيام` : `${n} يوماً`);
const hoursAr = (n: number) => (n === 1 ? "ساعة" : n === 2 ? "ساعتين" : n <= 10 ? `${n} ساعات` : `${n} ساعة`);

/** Next Sunday 03:00 UTC (weekly) or next 05:00 UTC (daily), as "in Nd" / "in Nh". */
function nextRun(kind: "weekly" | "daily", lang: Lang) {
  const now = new Date();
  const n = new Date(now);
  if (kind === "weekly") { n.setUTCHours(3, 0, 0, 0); n.setUTCDate(n.getUTCDate() + ((7 - n.getUTCDay()) % 7 || (n <= now ? 7 : 0))); if (n <= now) n.setUTCDate(n.getUTCDate() + 7); }
  else { n.setUTCHours(5, 0, 0, 0); if (n <= now) n.setUTCDate(n.getUTCDate() + 1); }
  const h = Math.max(1, Math.round((n.getTime() - now.getTime()) / 36e5));
  return h >= 24 ? (lang === "ar" ? `بعد ${daysAr(Math.round(h / 24))}` : `in ${Math.round(h / 24)}d`) : (lang === "ar" ? `بعد ${hoursAr(h)}` : `in ${h}h`);
}
function ago(iso: string | undefined, lang: Lang) {
  if (!iso) return lang === "ar" ? "لم يُشغَّل بعد" : "never";
  const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 36e5));
  if (h === 0) return lang === "ar" ? "الآن" : "just now";
  return h >= 48 ? (lang === "ar" ? `قبل ${daysAr(Math.round(h / 24))}` : `${Math.round(h / 24)}d ago`) : (lang === "ar" ? `قبل ${hoursAr(h)}` : `${h}h ago`);
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
          {tiles.map((x) => <Link key={x.l} href={x.href} className="rounded-lg bg-background-muted p-2"><p className="text-xs text-foreground-muted">{x.l}</p><p className="font-display text-xl font-bold text-foreground" dir="ltr">{x.v}</p></Link>)}
        </div>
        <Link href={`${base}/integrations`} className="mt-3 block rounded-lg border border-dashed border-border p-2 text-center text-xs text-foreground-muted hover:border-border-strong hover:text-foreground">{H.connectAnalytics}</Link>
      </Box>
      <Box title={H.channels} href={`${base}/integrations`} action={H.addChannel}>
        {connections.length === 0 ? <p className="text-xs text-foreground-muted">{H.noChannels}</p> : (
          <ul className="flex flex-wrap gap-1.5">{connections.map((c) => <li key={c.provider} className="badge badge-primary">{c.provider}</li>)}</ul>
        )}
      </Box>
      <Box title={H.taskFeed} href={`${base}/tasks`} action={H.manage}>
        <ul className="space-y-2">
          {tasks.map((x) => (
            <li key={x.l} className="text-xs">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-medium"><span className={`h-1.5 w-1.5 rounded-full ${x.on ? "bg-foreground" : "bg-foreground/20"}`} />{x.l}</span>
                <Link href={`${base}/tasks`} className="text-foreground hover:underline">{H.runNow}</Link>
              </div>
              <p className="ms-3.5 text-xs text-foreground-muted">{x.on ? H.live : H.paused} · {H.next} {x.next} · {H.last} {x.last}</p>
            </li>
          ))}
        </ul>
        {briefLines.length > 0 && (
          <div className="mt-3 rounded-lg bg-background-muted p-3 text-xs">
            <p className="font-semibold">{H.latestRun}</p>
            {briefLines.map((l, i) => <p key={i} className="mt-1 text-foreground-muted" dir="auto">{l}</p>)}
          </div>
        )}
        {action && (
          <div className="mt-3 rounded-lg border border-lemon/50 bg-lemon/10 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-semibold" dir="auto"><Icon name="bell" className="h-3.5 w-3.5 text-danger" />{action.title}</p>
            <p className="mt-1 text-foreground-muted" dir="auto">{action.body}</p>
            <Link href={action.href} className="btn btn-primary btn-xs mt-2">{H.review}</Link>
          </div>
        )}
      </Box>
      <Box title={H.assets} href={`${base}/files`} action={H.all}>
        {files.length === 0 ? <p className="text-xs text-foreground-muted">{H.noFiles}</p> : (
          <ul className="space-y-1.5">{files.slice(0, 4).map((f) => <li key={f.name} className="flex items-center justify-between text-xs"><Link href={`${base}/files`} className="hover:text-foreground" dir="ltr">{f.name}</Link><span className="font-mono text-xs text-foreground-muted" dir="ltr">{f.updatedAt.slice(5, 10)}</span></li>)}</ul>
        )}
        <Link href={`${base}/onboarding`} className="mt-3 block rounded-lg border border-dashed border-border p-2 text-center text-xs text-foreground-muted hover:border-border-strong hover:text-foreground">{H.completeBrand}</Link>
      </Box>
    </aside>
  );
}
