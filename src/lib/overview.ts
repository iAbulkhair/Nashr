/**
 * The workspace overview (rule 3507): what the charts on `/{lang}/app/b/{id}/overview` draw, from the numbers the Reports
 * page already computes (`kpis` in src/lib/stats.ts over the brand's own tasks, one `listLite` read and one waiting-set
 * read, no read per item). Pure: no I/O here, so the page's numbers and their tests are the same function. Nothing is
 * estimated or invented: a value is a count of stored tasks, and a chart with nothing to count is not drawn at all.
 */
import type { Kpis } from "./stats";
import type { Lang } from "./i18n";
import { kpiDelta } from "./kpi-delta";

/** The overview's window: the last 30 days, compared with the 30 before. */
export const OVERVIEW_RANGE = "30";

export type OverviewTile = { key: "created" | "approved" | "published" | "creditsUsed" | "pending"; value: number; delta: string };
export type OverviewBar = { date: string; created: number; approved: number; published: number };
export type Overview = {
  /** True when the window and the one before hold no task and nothing waits: the page shows its empty state only. */
  empty: boolean;
  tiles: OverviewTile[];
  daily: OverviewBar[];
  /** The tallest daily value, at least 1: the bar chart's scale. */
  dailyMax: number;
  /** Created, approved, published in the window, each its own count (an item approved here may have been created before). */
  funnel: { key: "created" | "approved" | "published"; value: number }[];
  /** Task types by count, largest first, at most 6. */
  types: [string, number][];
  typesMax: number;
  window: Kpis["window"];
};

export const OVERVIEW_COPY = {
  ar: {
    sub: "أرقام علامتك في آخر 30 يوماً، من مهامك المحفوظة فقط.",
    created: "عناصر أُنشئت", approved: "اعتُمدت", published: "نُشرت", creditsUsed: "كريدت مستهلك", pending: "بانتظار موافقتك",
    prev: "الـ30 يوماً السابقة",
    daily: "كل يوم", dailyDesc: (n: number) => `أعمدة يومية لآخر ${n} يوماً: ما أُنشئ وما اعتُمد وما نُشر.`,
    funnel: "من الإنشاء إلى النشر", types: "حسب النوع",
    emptyTitle: "لا أرقام بعد", emptyBody: "حين يُنشئ فريقك أول عناصر لهذه العلامة تظهر رسومها هنا.", emptyAction: "اطلب أول دفعة",
    reports: "التقارير الكاملة", table: "الأرقام كجدول", day: "اليوم",
  },
  en: {
    sub: "Your brand's numbers over the last 30 days, from your saved tasks only.",
    created: "Items created", approved: "Approved", published: "Published", creditsUsed: "Credits used", pending: "Waiting for you",
    prev: "previous 30 days",
    daily: "Day by day", dailyDesc: (n: number) => `Daily bars for the last ${n} days: created, approved and published.`,
    funnel: "From created to published", types: "By type",
    emptyTitle: "No numbers yet", emptyBody: "When your team makes the first items for this brand, their charts show here.", emptyAction: "Ask for a first batch",
    reports: "Full reports", table: "Numbers as a table", day: "Day",
  },
} as const;

/** Rule 3507: the overview from one `kpis` result. */
export function overviewOf(k: Kpis, lang: Lang): Overview {
  const C = OVERVIEW_COPY[lang];
  const types = Object.entries(k.byType).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const daily = k.daily.map(({ date, created, approved, published }) => ({ date, created, approved, published }));
  return {
    empty: k.created === 0 && k.createdPrev === 0 && k.pending === 0,
    tiles: [
      { key: "created", value: k.created, delta: kpiDelta(k.created, k.createdPrev, C.prev) },
      { key: "approved", value: k.approved, delta: "" },
      { key: "published", value: k.published, delta: "" },
      { key: "creditsUsed", value: k.creditsUsed, delta: kpiDelta(k.creditsUsed, k.creditsUsedPrev, C.prev) },
      { key: "pending", value: k.pending, delta: "" },
    ],
    daily,
    dailyMax: Math.max(1, ...daily.map((d) => Math.max(d.created, d.approved, d.published))),
    funnel: [
      { key: "created", value: k.created },
      { key: "approved", value: k.approved },
      { key: "published", value: k.published },
    ],
    types,
    typesMax: Math.max(1, ...types.map(([, n]) => n)),
    window: k.window,
  };
}
