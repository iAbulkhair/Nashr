import type { Lang } from "./shared";

/** One account's month split four ways (GET /api/admin/users/{email} `breakdown`, rule 2906): calls and cost per value. */
export type Breakdown = Record<"person" | "brand" | "model" | "day", Record<string, { calls: number; usd: number }>>;

const BD = {
  en: { title: "AI usage this month", person: "By person", brand: "By brand", model: "By model", day: "By day", none: "No model calls yet this month." },
  ar: { title: "استخدام الذكاء الاصطناعي هذا الشهر", person: "حسب الشخص", brand: "حسب العلامة", model: "حسب النموذج", day: "حسب اليوم", none: "لا طلبات للنماذج هذا الشهر بعد." },
};

/**
 * The founder's per-account breakdown in the user sheet: who ran the calls (owner, member:{login}, support, app, system),
 * which brand (by name when the account has it), which model and which UTC day. Days run oldest first, the rest by cost.
 */
export default function UsageBreakdown({ b, lang, brands = [] }: { b: Breakdown; lang: Lang; brands?: { id: string; name: string }[] }) {
  const T = BD[lang];
  const names = new Map(brands.map((x) => [x.id, x.name]));
  const dims = (["person", "brand", "model", "day"] as const).filter((d) => Object.keys(b[d] ?? {}).length > 0);
  return (
    <div className="col-span-full rounded border border-border p-2" data-testid="usage-breakdown">
      <p className="text-foreground-muted">{T.title}</p>
      {dims.length === 0 ? <p className="mt-1 text-foreground-muted">{T.none}</p> : (
        <div className="mt-1 grid gap-3 sm:grid-cols-2">
          {dims.map((d) => (
            <div key={d} className="min-w-0 overflow-x-auto">
              <p className="font-semibold">{T[d]}</p>
              <table className="mt-1 w-full font-mono text-xs" dir="ltr">
                <tbody>
                  {Object.entries(b[d]).sort((x, y) => (d === "day" ? x[0].localeCompare(y[0]) : y[1].usd - x[1].usd)).map(([k, v]) => (
                    <tr key={k} className="border-t border-border">
                      <td className="py-0.5">{d === "brand" ? names.get(k) ?? k : k}</td>
                      <td className="text-end">{v.calls}×</td>
                      <td className="text-end">${v.usd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
