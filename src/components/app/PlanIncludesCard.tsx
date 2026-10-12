import { agentById } from "@/lib/agents";
import { appDict } from "@/lib/app-i18n";
import { mediaModel } from "@/lib/media-catalog";
import { formatCount } from "@/lib/pricing";
// Type only, as in EntitlementsTable: src/lib/entitlements.ts reaches the store, and this card needs none of it at runtime.
import type { EntitlementView } from "@/lib/entitlements";

/**
 * The billing page's "What your plan includes" card (rule 785): what the account gets, read from the same entitlement
 * view the founder's console shows (`entitlementView`, rule 784), so the owner and the founder see one set of numbers.
 *
 * It has no number of its own. Credits, seats, chat, the end day and the count of agents come from `view.ent` and
 * `view.used`; the video models and the agents are named from the media catalogue and the roster, over the lists in
 * `view.ent`, so a trial shows its three models and a live founder grant shows all of them without the card knowing why.
 * It never reads `view.grants`: who set a grant and the founder's note are private to the console (ruling R10). That is
 * kept by structure, not by habit: the prop type leaves the grants out (`Pick<EntitlementView, "ent" | "used">`), the
 * billing page hands over `{ ent, used }` only, and the card is a server component, so its props are not serialized into the
 * page (tests/entitlements-card.test.ts scans for a client directive and for the word `grants`). The one sentence of copy
 * about scope is the same for every plan (`appDict[lang].billing.includes.scope`).
 *
 * A server component with no state; the chat figures are the ones the chat card below it shows (`used.chat.used` of
 * `used.chat.allowance`, which is `ent.chat.monthly` for the period).
 */
export default function PlanIncludesCard({ view, lang }: { view: Pick<EntitlementView, "ent" | "used">; lang: "ar" | "en" }) {
  const t = appDict[lang].billing.includes;
  const { ent, used } = view;
  // A trial's chat messages and credits are granted once for the whole trial; a plan's renew each month (chat-allowance.ts).
  const trial = used.chat.period === "trial";
  const day = ent.endsAt ? ent.endsAt.slice(0, 10) : null;
  const rows: { key: string; label: string; value: string }[] = [
    { key: "credits", label: trial ? t.creditsTrial : t.credits, value: formatCount(ent.credits.monthly) },
    { key: "seats", label: t.seats, value: `${formatCount(used.seats)} / ${formatCount(ent.seats)}` },
    { key: "chat", label: trial ? t.chatTrial : t.chat, value: `${formatCount(used.chat.used)} / ${formatCount(used.chat.allowance)}` },
  ];
  // An ended trial's last day is in the past: "ends" would be false, so it reads "ended" (M2). Other states keep their label.
  if (day) rows.push({ key: "ends", label: ent.inactive === "trial_over" ? t.trialEnded : trial ? t.trialEnds : t.paidThrough, value: day });

  return (
    <section className="mt-6 card" aria-labelledby="plan-includes-title" data-plan-includes="">
      <h2 id="plan-includes-title" className="font-display text-lg font-bold">{t.title}</h2>
      <p className="mt-1 text-sm text-foreground-muted" data-plan-scope="">{t.scope}</p>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.key} data-plan-row={r.key}>
            <dt className="text-foreground-muted">{r.label}</dt>
            <dd className="font-mono text-lg" dir="ltr">{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-foreground/10 pt-4 text-sm">
        <p className="text-foreground-muted">{t.video}</p>
        <ul className="mt-1 flex flex-wrap gap-1.5" data-plan-row="video">
          {ent.media.video.map((id) => <li key={id} className="rounded-full bg-background-muted px-2.5 py-0.5 text-xs">{mediaModel(id).label[lang]}</li>)}
        </ul>
      </div>
      <div className="mt-4 text-sm">
        <p className="text-foreground-muted">{t.agents} <span className="font-mono" dir="ltr">{formatCount(ent.agents.length)}</span></p>
        <ul className="mt-1 flex flex-wrap gap-1.5" data-plan-row="agents">
          {ent.agents.map((id) => <li key={id} className="rounded-full bg-background-muted px-2.5 py-0.5 text-xs">{agentById(id).name[lang]}</li>)}
        </ul>
      </div>
    </section>
  );
}
