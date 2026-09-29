import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { todoPage } from "@/lib/secretary";
import { AGENDA_BUCKETS, AUTO_CLOSE_RESULT, approvalsLine, formatWhen, nextStepText, noteText, partyName, riyadhLocalInput, type AgendaEntry, type SecItem } from "@/lib/secretary-agenda";
import TodoPanel, { type TodoRow, type TodoSection } from "@/components/app/TodoPanel";

export const dynamic = "force-dynamic";

/**
 * My to-dos (Reem's list) for the active brand, rendered on the server: every date is formatted here in Riyadh time
 * and handed to the client as text, so the browser never formats a date and nothing differs at hydration.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const scope = sc(u);
  const t = appDict[lang];
  const T = t.todo;
  const { now, agenda, done, deleted, tonight } = await todoPage(scope);

  const badgesOf = (it: SecItem): string[] => [
    it.critical ? T.badges.critical : "",
    it.priority === 3 ? T.badges.urgent : it.priority === 2 ? T.badges.high : "",
    it.source === "chat" ? T.badges.chat : it.source === "mcp" ? T.badges.mcp : "",
    it.links?.taskId ? T.badges.linked : "",
  ].filter(Boolean);
  const whoOf = (it: SecItem) => (it.direction === "they_owe" ? `${T.owedBy} ${partyName(it.owedBy, lang)}` : it.owedTo ? `${T.owedTo}${lang === "ar" ? "" : " "}${partyName(it.owedTo, lang)}` : "");
  const row = (it: SecItem, e?: AgendaEntry): TodoRow => ({
    id: it.id, rev: it.rev, title: it.title, description: it.description,
    due: it.dueAt ? formatWhen(it.dueAt, it.allDay, lang, now) : null,
    dueLocal: it.dueAt ? riyadhLocalInput(Date.parse(it.dueAt)) : null,
    who: whoOf(it), next: e ? nextStepText(e, lang) : "", badges: badgesOf(it),
    proposed: it.proposedDone ? { by: it.proposedDone.by === "mcp" ? (lang === "ar" ? "مساعدك" : "Your assistant") : partyName(it.proposedDone.by, lang), evidence: it.proposedDone.evidence } : null,
    result: it.result === AUTO_CLOSE_RESULT ? T.autoClosed : it.result,
    // The owner's own page: private notes included, the "Not yet" note worded in the page's language.
    notes: it.notes.slice(-3).map((n) => noteText(n, lang)),
  });
  const sections: TodoSection[] = AGENDA_BUCKETS.filter((b) => agenda.buckets[b].length).map((b) => ({ bucket: b, title: T.buckets[b], rows: agenda.buckets[b].map((e) => row(e.item, e)) }));
  return (
    <TodoPanel
      t={t}
      sections={sections}
      approvals={agenda.approvals ? { line: approvalsLine(agenda.approvals, lang), href: `/${lang}/app` } : null}
      snoozed={agenda.snoozed}
      allClear={agenda.open > 0 && !agenda.counts.overdue && !agenda.counts.today}
      empty={agenda.open === 0}
      done={done.map((it) => row(it))}
      deleted={deleted.map((it) => row(it))}
      tonight={tonight}
    />
  );
}
