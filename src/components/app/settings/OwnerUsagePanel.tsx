import type { Lang } from "@/lib/i18n";
import type { OwnerUsage, ShareRow } from "@/lib/usage-report";
import { AGENTS } from "@/lib/agents";

export const OWNER_USAGE_COPY = {
  ar: {
    title: "استخدام الذكاء",
    sub: "عدد طلبات الذكاء الاصطناعي هذا الشهر، ومن طلبها، ولأي علامة، وأي وكيل نفّذها. الرصيد المخصوم في صفحة الاشتراك.",
    month: "الشهر", show: "اعرض", total: "مجموع الطلبات", none: "لا طلبات في هذا الشهر بعد.",
    person: "حسب الشخص", brand: "حسب العلامة", agent: "حسب الوكيل", model: "حسب النموذج", day: "حسب اليوم",
    requests: "الطلبات", share: "النسبة",
    who: { owner: "المالك", support: "دعم ذكين", app: "تطبيق مربوط", system: "مهام تلقائية", unknown: "غير معروف", member: "عضو" },
    defaultBrand: "العلامة الرئيسية",
  },
  en: {
    title: "AI usage",
    sub: "How many AI requests ran this month, who asked, for which brand and which agent did them. Credits spent are on the billing page.",
    month: "Month", show: "Show", total: "Total requests", none: "No requests this month yet.",
    person: "By person", brand: "By brand", agent: "By agent", model: "By model", day: "By day",
    requests: "Requests", share: "Share",
    who: { owner: "Owner", support: "Thakeen support", app: "Linked app", system: "Automatic jobs", unknown: "Unknown", member: "Member" },
    defaultBrand: "Main brand",
  },
} as const;

type Dim = "person" | "brand" | "agent" | "model" | "day";
const DIMS: readonly Dim[] = ["person", "brand", "agent", "model", "day"];

/**
 * The owner's own month (rule 2907), from `ownerUsage`: one table per dimension, requests and share of the month's
 * requests. No dollar figure is in `OwnerUsage`, so none can show here. The month picker is a plain GET form, so the
 * page stays server-rendered and works without script.
 */
export default function OwnerUsagePanel({ lang, view, brands }: { lang: Lang; view: OwnerUsage; brands: Record<string, string> }) {
  const T = OWNER_USAGE_COPY[lang];
  const label = (d: Dim, key: string): string => {
    if (d === "person") {
      if (key.startsWith("member:")) return key.slice("member:".length);
      return (T.who as Record<string, string>)[key] ?? key;
    }
    if (d === "brand") return brands[key] || (key === "default" ? T.defaultBrand : key);
    if (d === "agent") return AGENTS.find((a) => a.id === key)?.name[lang] ?? key;
    return key;
  };
  const dims = DIMS.filter((d) => view[d].length > 0);
  return (
    <div className="mt-4 grid gap-4" data-testid="owner-usage">
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          <span className="text-foreground-muted">{T.month}</span>
          <input type="month" name="month" defaultValue={view.month} className="input w-44" dir="ltr" />
        </label>
        <button type="submit" className="btn btn-secondary">{T.show}</button>
      </form>
      <p className="text-sm">
        <span className="text-foreground-muted">{T.total}: </span>
        <span className="font-semibold tabular-nums" data-testid="owner-usage-total">{view.total.calls}</span>
      </p>
      {dims.length === 0 ? <p className="text-foreground-muted">{T.none}</p> : (
        <div className="grid gap-4 md:grid-cols-2">
          {dims.map((d) => <ShareTable key={d} title={T[d]} rows={view[d]} label={(k) => label(d, k)} requests={T.requests} share={T.share} />)}
        </div>
      )}
    </div>
  );
}

function ShareTable({ title, rows, label, requests, share }: { title: string; rows: ShareRow[]; label: (k: string) => string; requests: string; share: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-foreground-muted">
              <th scope="col" className="py-1 text-start font-normal"><span className="sr-only">{title}</span></th>
              <th scope="col" className="py-1 text-end font-normal">{requests}</th>
              <th scope="col" className="py-1 text-end font-normal">{share}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="max-w-[16rem] truncate py-1"><bdi>{label(r.key)}</bdi></td>
                <td className="py-1 text-end tabular-nums">{r.calls}</td>
                <td className="py-1 text-end tabular-nums" dir="ltr">{r.share}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
