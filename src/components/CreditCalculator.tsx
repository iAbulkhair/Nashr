import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import CreditCalculatorForm, { type CalcPlan, type CalcRow } from "@/components/CreditCalculatorForm";
import Face from "@/components/home/Face";
import { AGENT_CAST } from "@/lib/home";
import { creditCost, type Dict, type Lang } from "@/lib/i18n";
import { AGENCY_MIN, PLAN_CREDITS, PUBLIC_TIERS } from "@/lib/pricing";
import type { TaskType } from "@/lib/tasks";

type L = Record<Lang, string>;

/**
 * The task types the calculator asks about (rule 1885), in reading order. `perItem`: priced per item of the batch, as
 * the credits table does (a social post is one of ten). `start`: the count it opens with; only the weekly plan starts
 * above zero, because it is drafted on its own every Sunday for the first brand.
 */
export const CALC_TYPES: readonly { type: TaskType; perItem?: boolean; start: number; label: L }[] = [
  { type: "social", perItem: true, start: 0, label: { ar: "منشورات سوشال", en: "Social posts" } },
  { type: "article", start: 0, label: { ar: "مقالات SEO", en: "SEO articles" } },
  { type: "ads", perItem: true, start: 0, label: { ar: "إعلانات", en: "Ads" } },
  { type: "whatsapp", perItem: true, start: 0, label: { ar: "رسائل واتساب", en: "WhatsApp messages" } },
  { type: "weekly_plan", start: 4, label: { ar: "خطط الأسبوع (تُجهَّز كل أحد)", en: "Weekly plans (one each Sunday)" } },
  { type: "weekly_report", start: 0, label: { ar: "تقارير أسبوعية", en: "Weekly reports" } },
];

export const CALC_COPY = {
  h: { ar: "احسبها مع رزان", en: "Work it out with Razan" },
  /** Razan's one line (rule 1887): what the calculator does, no saving and no result promised. */
  intro: { ar: "قل لي وش تحتاج بالشهر، وأحسب لك كم كريدت يلزمك وأي خطة تكفيك.", en: "Tell me what you need each month, and I'll work out the credits it takes and the plan that covers it." },
  note: {
    ar: "الدردشة مع الفريق لا تُحسب هنا: لكل خطة رسائلها الشهرية. والصور تُحسب حسب النموذج، كما في الجدول أعلاه.",
    en: "Chatting with the team is not counted here: each plan has its own monthly messages. Images are priced by model, as in the table above.",
  },
} satisfies Record<string, L>;

/**
 * Razan's credit calculator on /pricing (rules 1885-1887). Every cost is `creditCost` (TASK_COST / TASK_COUNT) and every
 * plan's credits PLAN_CREDITS or AGENCY_MIN, passed to the form as data; the form picks the plan with `smallestPlanFor`.
 * Nothing here is typed as a number.
 */
export default function CreditCalculator({ t, lang, level = 2 }: { t: Dict; lang: Lang; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  const rtl = lang === "ar";
  const razan = AGENT_CAST.find((a) => a.id === "razan")!;
  const rows: CalcRow[] = CALC_TYPES.map((r) => ({ type: r.type, label: r.label[lang], cost: creditCost(r.type, r.perItem), start: r.start }));
  const plans: CalcPlan[] = PUBLIC_TIERS.flatMap((id) => {
    const card = t.pricing.plans.find((p) => p.id === id);
    return card ? [{ id, name: card.name, credits: id === "agency" ? AGENCY_MIN.credits : PLAN_CREDITS[id], price: card.price, period: card.period }] : [];
  });
  return (
    <section id="calculator" aria-labelledby="calc-h" className="scroll-mt-20">
      <div className="section-wrap">
        <H id="calc-h" className="section-title">
          <span className="s-ul">
            <ScribbleStatic kind="underline" seed="calc-h" rtl={rtl} />
            {CALC_COPY.h[lang]}
          </span>
        </H>
        <div className="mt-5 flex items-end gap-3">
          <Face who={razan.id} seed="calc-razan" />
          <p className="s-bubble max-w-prose" data-tail="start">
            <Scribble kind="bubble" seed="calc-razan-b" tail="start" rtl={rtl} />
            <span className="sr-only">{razan.name[lang]}: </span>
            {CALC_COPY.intro[lang]}
          </p>
        </div>
        <CreditCalculatorForm lang={lang} rows={rows} plans={plans} />
        <p className="mt-4 max-w-prose text-sm text-foreground-muted">{CALC_COPY.note[lang]}</p>
      </div>
    </section>
  );
}
