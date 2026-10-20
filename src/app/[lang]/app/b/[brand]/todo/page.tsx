import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { SERIES_ID, isWaNumber, ruleText, todoPage } from "@/lib/secretary";
import { AWAY_AHEAD_DAYS, awayListOf } from "@/lib/secretary-away";
import { namesSharjah } from "@/lib/secretary-calendar";
import { isAgentId } from "@/lib/agents";
import { can } from "@/lib/roles";
import { getProvider, isAvailable } from "@/lib/connectors/registry";
import {
  AGENDA_BUCKETS, AUTO_CLOSE_RESULT, addDays, approvalsLine, briefClock, formatWhen, linkFactText, nextStepParts, noteText, partyKey, partyName, resultText, zoneDay, zoneLocalInput, zoneTimeLabel,
  type AgendaEntry, type SecItem,
} from "@/lib/secretary-agenda";
import { fill } from "@/lib/fill";
import TodoPanel, { type TodoRow, type TodoSection } from "@/components/app/TodoPanel";
import WorkingDaysPanel from "@/components/app/WorkingDaysPanel";
import SeriesPanel, { type SeriesRow } from "@/components/app/SeriesPanel";
import { appHref } from "@/lib/app-href";

export const dynamic = "force-dynamic";

/** Whether a calendar provider's app keys are set (Reem B3): false shows «قريباً» in place of its button. */
const calReady = (id: "gcal" | "mscal") => {
  const p = getProvider(id);
  return !!p && isAvailable(p);
};

/**
 * My to-dos (Reem's list) for the active brand, rendered on the server: every date of the list is formatted here in the
 * brand's zone and handed to the client as text, so nothing in the list differs at hydration. The Away and Working days
 * panels get local days ("YYYY-MM-DD") instead and write them in the browser through `dates.ts` (a save brings new
 * ones back), each in an element marked `suppressHydrationWarning` for the wording ICU builds differ on. A
 * reminder reads "at {time}" only while timed reminders run (`timed`); otherwise it says it comes with the next
 * morning brief, at the brief's local time in the brand's zone (`briefClock`). A they-owe item with a contact number
 * gets a wa.me link with a fixed message: nothing is sent. Templates that take a title or a name are filled in one pass
 * (`fill`), so what someone typed is inserted as typed.
 *
 * Under the list: the away list (`awayListOf`), whose name field suggests the open items' contacts and which a contact's
 * row opens with "Away until…", and the brand's Working days (`working`: the settings, what is in force, the next
 * 12 months of days off, this and next year's Eid), which an admin edits and a member reads (`brand.write`); a brand in
 * Sharjah is told Friday is in its government's weekend. A debt the chase rule holds back says why under its WhatsApp
 * link (`nextStepParts`). `?series={id}` (an id of the right form; anything else counts as absent) shows one recurring
 * series' closed copies instead of the list, read from that series' set only (`todoPage(scope, { series })`). A
 * recurring row carries its rule in words (`ruleText`, with the Hijri anchor the Hijri rules need) and the rule's fields
 * for the form. The brand file, `sec:cal` and `sec:away` are the records the agenda was read with
 * (`todoPage`), at the same instant: nothing is read twice.
 */
export const generateMetadata = appScreenMeta("todo");

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams?: Promise<{ series?: string | string[] }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  const scope = sc(u);
  const t = appDict[lang];
  const T = t.todo;
  const rawSeries = (await searchParams)?.series;
  const seriesId = typeof rawSeries === "string" && SERIES_ID.test(rawSeries) ? rawSeries : null;
  // Who closed a copy: the login when there is one, else who acted, in words.
  const whoClosed = (cb: NonNullable<SecItem["closedBy"]>) => cb.login ?? (isAgentId(cb.actor) ? t.agents[cb.actor].name : cb.actor === "owner" ? T.repeat.who.owner : cb.actor === "mcp" ? T.repeat.who.mcp : T.repeat.who.auto);
  const closedByOf = (it: SecItem) => (it.closedBy ? fill(T.repeat.closedBy, { who: whoClosed(it.closedBy) }) : null);
  if (seriesId) {
    const { now, zone, series } = await todoPage(scope, { series: seriesId });
    const fmt = (iso: string, allDay = false) => formatWhen(iso, allDay, lang, now, zone);
    const rows: SeriesRow[] = series.items.map((it) => ({
      id: it.id, title: it.title, due: it.dueAt ? fmt(it.dueAt, it.allDay) : null, closedAt: it.completedAt ? fmt(it.completedAt) : null,
      result: it.result === AUTO_CLOSE_RESULT ? T.autoClosed : resultText(it.result, lang), closedBy: closedByOf(it),
    }));
    return <SeriesPanel t={t} id={series.id} rows={rows} total={series.total} kept={series.kept} canWrite={can(u, "todo.write")} canClose={can(u, "todo.close")} backHref={`/${lang}/app/todo`} exportHref={`/api/secretary/series/${series.id}/export?lang=${lang}`} />;
  }
  const { now, zone, agenda, done, deleted, facts, tonight, timed, brand, working: cal, awayRows } = await todoPage(scope);
  const awayList = awayListOf(awayRows, now, zone);
  const today = zoneDay(now, zone);
  const when = (iso: string, allDay = false) => formatWhen(iso, allDay, lang, now, zone);
  // When the next morning brief comes in this brand's zone: 08:00 in Riyadh, 09:00 in Dubai.
  const brief = briefClock(zone);

  const badgesOf = (it: SecItem): string[] => [
    it.critical ? T.badges.critical : "",
    it.priority === 3 ? T.badges.urgent : it.priority === 2 ? T.badges.high : "",
    it.source === "chat" ? T.badges.chat : it.source === "mcp" ? T.badges.mcp : it.source === "booking" ? T.badges.booking : it.source === "agent" && it.handoffFrom && isAgentId(it.handoffFrom) ? fill(T.badges.agent, { name: t.agents[it.handoffFrom].name }) : "",
    it.links?.taskId ? T.badges.linked : "",
  ].filter(Boolean);
  const whoOf = (it: SecItem) => (it.direction === "they_owe" ? `${T.owedBy} ${partyName(it.owedBy, lang)}` : it.owedTo ? `${T.owedTo}${lang === "ar" ? "" : " "}${partyName(it.owedTo, lang)}` : "");
  // An agent's "done" is its claim, attributed with the right verb («ريم تقول»، «سامي يقول»، «مساعدك يقول»).
  const claimBy = (by: NonNullable<SecItem["proposedDone"]>) => (isAgentId(by.by) ? `${t.agents[by.by].name} ${t.agents[by.by].says}` : T.assistantSays);
  // The fact comes from the stored inbox task, read by code; never from the claim.
  const factOf = (it: SecItem) => (it.links?.taskId ? linkFactText(facts[it.links.taskId], lang, now, zone) : "");
  // The WhatsApp link of a they-owe item with a number: a fixed message in the page's language, opened by the owner.
  const whatsapp = (it: SecItem) => (isWaNumber(it.phone) && it.owedBy !== "owner" && !it.completedAt && !it.deletedAt
    ? `https://wa.me/${it.phone}?text=${encodeURIComponent(fill(T.waMsg, { name: partyName(it.owedBy, lang), title: it.title }))}`
    : null);
  // A contact, as the away list knows one: someone other than the owner and the agents.
  const contactOf = (it: SecItem) => (it.owedBy !== "owner" && !isAgentId(it.owedBy) ? it.owedBy : null);
  // The next step, and on its own line why the chase rule holds the item back (ruling R9: only while it waits).
  const stepOf = (e?: AgendaEntry): Pick<TodoRow, "next" | "reason"> => {
    if (!e) return { next: "" };
    const { step, reason } = nextStepParts(e, lang, zone, { now });
    return reason ? { next: step, reason } : { next: step };
  };
  const row = (it: SecItem, e?: AgendaEntry): TodoRow => ({
    id: it.id, rev: it.rev, title: it.title, description: it.description,
    due: it.dueAt ? when(it.dueAt, it.allDay) : null,
    dueLocal: it.dueAt ? zoneLocalInput(Date.parse(it.dueAt), zone) : null,
    who: whoOf(it), ...stepOf(e), badges: badgesOf(it),
    theirs: it.owedBy !== "owner",
    chase: [
      !it.dueAt && it.expectBy && it.owedBy !== "owner" ? `${T.expectBy} ${when(it.expectBy)}` : "",
      it.lastChasedAt ? `${T.lastChased}: ${when(it.lastChasedAt)}` : "",
    ].filter(Boolean).join(" · "),
    proposed: it.proposedDone ? { claim: `${claimBy(it.proposedDone)}: «${it.proposedDone.evidence}»` } : null,
    fact: factOf(it),
    result: it.result === AUTO_CLOSE_RESULT ? T.autoClosed : resultText(it.result, lang),
    // A recurring copy: its rule in words (the Hijri month and day of the anchor for the Hijri rules), the rule's fields
    // for the form, the series' history link, and on a closed copy who closed it.
    repeat: it.repeat ? ruleText(it.repeat, zone, lang) : null,
    repeatRule: it.repeat ? { every: it.repeat.every, interval: it.repeat.interval, weekdays: it.repeat.weekdays ?? [], monthDay: it.repeat.monthDay ?? null, until: it.repeat.until ?? "", count: it.repeat.count ?? null, remindBefore: it.repeat.remindBefore ?? null } : null,
    seriesId: it.series?.id ?? null,
    closedBy: it.completedAt ? closedByOf(it) : null,
    // The owner's own page: private notes included, the notes code writes worded in the page's language.
    notes: it.notes.slice(-3).map((n) => noteText(n, lang)),
    remind: it.remindAt ? fill(timed ? T.remindAt : T.remindBrief, { when: when(it.remindAt), brief }) : null,
    remindLocal: it.remindAt ? zoneLocalInput(Date.parse(it.remindAt), zone) : null,
    phone: it.owedBy !== "owner" ? (it.phone ?? null) : null,
    whatsapp: whatsapp(it),
    contact: e ? contactOf(it) : null,
    // An open booking item whose start has passed (a booking's start is its due time): the follow-up panel opens from it.
    meeting: it.source === "booking" && !it.completedAt && !it.deletedAt && !!it.dueAt && Date.parse(it.dueAt) <= now,
  });
  const sections: TodoSection[] = AGENDA_BUCKETS.filter((b) => agenda.buckets[b].length).map((b) => ({ bucket: b, title: T.buckets[b], rows: agenda.buckets[b].map((e) => row(e.item, e)) }));
  // The names the away form suggests: each contact on the open items once, however its name was typed (`partyKey`).
  const seen = new Set<string>();
  const labels = AGENDA_BUCKETS.flatMap((b) => agenda.buckets[b]).map((e) => contactOf(e.item)).filter((c): c is string => {
    const key = c === null ? null : (partyKey(c) ?? c);
    if (key === null || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <TodoPanel
      t={t}
      zoneLabel={zoneTimeLabel(zone, lang)}
      sections={sections}
      approvals={agenda.approvals ? { line: approvalsLine(agenda.approvals, lang), href: `/${lang}/app` } : null}
      snoozed={agenda.snoozed}
      allClear={agenda.open > 0 && !agenda.counts.overdue && !agenda.counts.today}
      empty={agenda.open === 0}
      done={done.map((it) => row(it))}
      deleted={deleted.map((it) => row(it))}
      tonight={tonight}
      canClose={can(u, "todo.close")}
      canWrite={can(u, "todo.write")}
      todoHref={`/${lang}/app/todo`}
      timed={timed}
      briefAt={brief}
      lang={lang}
      inboxHref={`/${lang}/app`}
      away={{ entries: awayList, labels, canEdit: can(u, "todo.write"), today, last: addDays(today, AWAY_AHEAD_DAYS) }}
      canLinkCalendar={can(u, "calendar.link")}
      calProviders={{ gcal: calReady("gcal"), mscal: calReady("mscal") }}
    >
      <WorkingDaysPanel
        t={t}
        lang={lang}
        calendar={cal.calendar}
        effective={cal.effective}
        upcoming={cal.upcoming}
        eids={cal.eids}
        canEdit={can(u, "brand.write")}
        cityHint={namesSharjah(brand?.city)}
        today={today}
      />
    </TodoPanel>
  );
}
