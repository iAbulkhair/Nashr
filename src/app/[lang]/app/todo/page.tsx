import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { isWaNumber, todoPage } from "@/lib/secretary";
import { isAgentId } from "@/lib/agents";
import { can } from "@/lib/roles";
import {
  AGENDA_BUCKETS, AUTO_CLOSE_RESULT, approvalsLine, briefClock, formatWhen, linkFactText, nextStepText, noteText, partyName, zoneLocalInput, zoneTimeLabel,
  type AgendaEntry, type SecItem,
} from "@/lib/secretary-agenda";
import { fill } from "@/lib/fill";
import TodoPanel, { type TodoRow, type TodoSection } from "@/components/app/TodoPanel";

export const dynamic = "force-dynamic";

/**
 * My to-dos (Reem's list) for the active brand, rendered on the server: every date is formatted here in the brand's
 * zone and handed to the client as text, so the browser never formats a date and nothing differs at hydration. A
 * reminder reads "at {time}" only while timed reminders run (`timed`); otherwise it says it comes with the next
 * morning brief, at the brief's local time in the brand's zone (`briefClock`). A they-owe item with a contact number
 * gets a wa.me link with a fixed message: nothing is sent. Templates that take a title or a name are filled in one pass
 * (`fill`), so what someone typed is inserted as typed.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const scope = sc(u);
  const t = appDict[lang];
  const T = t.todo;
  const { now, zone, agenda, done, deleted, facts, tonight, timed } = await todoPage(scope);
  const when = (iso: string, allDay = false) => formatWhen(iso, allDay, lang, now, zone);
  // When the next morning brief comes in this brand's zone: 08:00 in Riyadh, 09:00 in Dubai.
  const brief = briefClock(zone);

  const badgesOf = (it: SecItem): string[] => [
    it.critical ? T.badges.critical : "",
    it.priority === 3 ? T.badges.urgent : it.priority === 2 ? T.badges.high : "",
    it.source === "chat" ? T.badges.chat : it.source === "mcp" ? T.badges.mcp : it.source === "agent" && it.handoffFrom && isAgentId(it.handoffFrom) ? fill(T.badges.agent, { name: t.agents[it.handoffFrom].name }) : "",
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
  const row = (it: SecItem, e?: AgendaEntry): TodoRow => ({
    id: it.id, rev: it.rev, title: it.title, description: it.description,
    due: it.dueAt ? when(it.dueAt, it.allDay) : null,
    dueLocal: it.dueAt ? zoneLocalInput(Date.parse(it.dueAt), zone) : null,
    who: whoOf(it), next: e ? nextStepText(e, lang, zone, { now }) : "", badges: badgesOf(it),
    theirs: it.owedBy !== "owner",
    chase: [
      !it.dueAt && it.expectBy && it.owedBy !== "owner" ? `${T.expectBy} ${when(it.expectBy)}` : "",
      it.lastChasedAt ? `${T.lastChased}: ${when(it.lastChasedAt)}` : "",
    ].filter(Boolean).join(" · "),
    proposed: it.proposedDone ? { claim: `${claimBy(it.proposedDone)}: «${it.proposedDone.evidence}»` } : null,
    fact: factOf(it),
    result: it.result === AUTO_CLOSE_RESULT ? T.autoClosed : it.result,
    // The owner's own page: private notes included, the notes code writes worded in the page's language.
    notes: it.notes.slice(-3).map((n) => noteText(n, lang)),
    remind: it.remindAt ? fill(timed ? T.remindAt : T.remindBrief, { when: when(it.remindAt), brief }) : null,
    remindLocal: it.remindAt ? zoneLocalInput(Date.parse(it.remindAt), zone) : null,
    phone: it.owedBy !== "owner" ? (it.phone ?? null) : null,
    whatsapp: whatsapp(it),
  });
  const sections: TodoSection[] = AGENDA_BUCKETS.filter((b) => agenda.buckets[b].length).map((b) => ({ bucket: b, title: T.buckets[b], rows: agenda.buckets[b].map((e) => row(e.item, e)) }));
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
      timed={timed}
      briefAt={brief}
      lang={lang}
      inboxHref={`/${lang}/app`}
    />
  );
}
