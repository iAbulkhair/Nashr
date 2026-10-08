import type { ReactNode } from "react";
import { agentById } from "@/lib/agents";
import { mediaModel, type VideoModelId } from "@/lib/media-catalog";
// Type only: src/lib/entitlements.ts reaches the store (rate.ts, team.ts, chat-allowance.ts), so it is never imported at
// runtime here or in AdminConsole (rule 781, tests/entitlements-scan.test.ts); the type is erased from the bundle.
import type { EntitlementView } from "@/lib/entitlements";
import type { AgencyDeal } from "@/lib/pricing";

/**
 * The founder's entitlements table for one account (spec 6.1, rule 784): one row per dimension, with the plan's own
 * value (`view.base`, the account's `entitlements()` without its four overrides), what differs from it (the override),
 * the effective value (`view.ent`), what is used and when it resets. Every figure comes from `view`, none is worked out
 * here.
 *
 * The Override cell shows what differs from the plan: the Agency deal (credits@price and who set it, from `deal`, which the
 * view does not carry; shown whenever the account has a deal, even one at the Business rate whose credits equal the plan's),
 * a seat override, a chat override and the dated video grant (day, who, note). The deal, seat and chat overrides have no end
 * date. A grant that has run out is greyed and marked "expired": the effective list is then the plan's own.
 *
 * Days, emails and credits@price are left-to-right islands (`Ltr`) so the right-to-left text around them cannot turn or break them;
 * the table scrolls sideways inside its own box instead of widening the page.
 */
const T = {
  en: {
    title: "Entitlements", dimension: "Dimension", plan: "Plan", override: "Override", effective: "Effective", used: "Used", resets: "Resets",
    credits: "Credits per month", seats: "Seats", chatMonth: "Chat messages (month)", chatTrial: "Chat messages (trial)", chatRate: "Chat rate (hour / day)",
    video: "Video models", agents: "Agents", status: "Active / ends",
    balance: "balance", noEnd: "no end date", active: "active", expired: "expired", until: "until", by: "by", all: "all models", deal: "deal",
    inactive: { suspended: "suspended", trial_over: "trial over", billing_locked: "billing locked" },
  },
  ar: {
    title: "الاستحقاقات", dimension: "البند", plan: "الخطة", override: "التخصيص", effective: "الفعلي", used: "المستخدم", resets: "يتجدد",
    credits: "الكريدت الشهري", seats: "المقاعد", chatMonth: "رسائل الدردشة (الشهر)", chatTrial: "رسائل الدردشة (التجربة)", chatRate: "سقف الدردشة (ساعة / يوم)",
    video: "نماذج الفيديو", agents: "الوكلاء", status: "مفعّل / ينتهي",
    balance: "الرصيد", noEnd: "بلا تاريخ انتهاء", active: "مفعّل", expired: "منتهية", until: "حتى", by: "بواسطة", all: "كل النماذج", deal: "عقد",
    inactive: { suspended: "موقوف", trial_over: "انتهت التجربة", billing_locked: "الدفع مقفل" },
  },
} as const;

/** One row of the table. A cell is text, or a node where a day, an email or credits@price must stay left to right. */
type Row = { key: string; label: string; plan: ReactNode; override: ReactNode; effective: ReactNode; used: string; resets: string };

const DASH = "—";

/**
 * A day, an email or credits@price inside right-to-left text. `bdi` isolates it from the Arabic around it, `dir="ltr"` keeps
 * its own order (an ISO day reads 2026-10-11, not 11-10-2026) and no-wrap stops a break in the middle of it (M5).
 */
const Ltr = ({ children }: { children: ReactNode }) => <bdi dir="ltr" className="whitespace-nowrap">{children}</bdi>;

/** The Agency deal as the stored record has it; `setBy` may be missing on an old deal. */
type DealCell = Pick<AgencyDeal, "credits" | "priceSar"> & Partial<Pick<AgencyDeal, "setBy">>;

/**
 * What the console's "Video grant" button sends to `POST /api/admin/plan` (rules 783-784, ruling R13), from the day and the
 * note the founder typed and whether the account has a grant on the record (live or expired). A day sends the grant (the
 * note trimmed, left out when blank); an empty day clears the grant when there is one and sends nothing when there is none,
 * so no request and no `admin:log` entry is made for a no-op. The day is not checked here: the server answers `bad_grant`
 * (`parseVideoGrant` pulls the store into whatever imports it, so the browser cannot use it).
 */
export function videoGrantRequest(until: string, note: string, hasGrant: boolean): { videoGrant: { until: string; note?: string } | null } | null {
  const day = until.trim();
  if (day === "") return hasGrant ? { videoGrant: null } : null;
  const text = note.trim();
  return { videoGrant: text ? { until: day, note: text } : { until: day } };
}

export default function EntitlementsTable({ view, lang, deal }: { view: EntitlementView; lang: "ar" | "en"; deal?: DealCell | null }) {
  const t = T[lang];
  const { ent, base, used, resetsAt, grants } = view;
  const g = grants.video;
  const models = (ids: readonly VideoModelId[]) => ids.map((id) => mediaModel(id).label[lang]).join(", ");
  const agents = (e: typeof ent) => e.agents.map((id) => agentById(id).name[lang]).join(", ");
  const state = (e: typeof ent) => (e.active ? t.active : t.inactive[e.inactive ?? "suspended"]);
  const statusText = (e: typeof ent) => [state(e), e.endsAt ? e.endsAt.slice(0, 10) : t.noEnd].join(" · ");
  const status = (e: typeof ent): ReactNode => <>{state(e)} · {e.endsAt ? <Ltr>{e.endsAt.slice(0, 10)}</Ltr> : t.noEnd}</>;
  const monthly = used.chat.period === "month";
  /** The override cell of a number: a dash when the effective value is the plan's, else the value. */
  const differs = (effective: string, plan: string): ReactNode => (effective === plan ? DASH : `${effective} · ${t.noEnd}`);
  /** The Agency deal and who set it: shown whenever the account has one, even at the Business rate (credits equal the plan's). */
  const dealCell: ReactNode = deal ? (
    <>{t.deal} <Ltr>{`${deal.credits}@${deal.priceSar} SAR`}</Ltr>{deal.setBy ? <> · {t.by} <Ltr>{deal.setBy}</Ltr></> : null} · {t.noEnd}</>
  ) : null;
  const rate = (e: typeof ent) => `${e.chat.hour} / ${e.chat.day}`;

  const rows: Row[] = [
    { key: "credits", label: t.credits, plan: String(base.credits.monthly), override: dealCell ?? differs(String(ent.credits.monthly), String(base.credits.monthly)), effective: String(ent.credits.monthly), used: `${t.balance} ${used.credits}`, resets: resetsAt ?? DASH },
    { key: "seats", label: t.seats, plan: String(base.seats), override: differs(String(ent.seats), String(base.seats)), effective: String(ent.seats), used: `${used.seats} / ${ent.seats}`, resets: DASH },
    { key: "chat", label: monthly ? t.chatMonth : t.chatTrial, plan: String(base.chat.monthly), override: differs(String(ent.chat.monthly), String(base.chat.monthly)), effective: String(ent.chat.monthly), used: `${used.chat.counted} / ${used.chat.allowance}`, resets: monthly ? resetsAt ?? DASH : DASH },
    { key: "rate", label: t.chatRate, plan: rate(base), override: differs(rate(ent), rate(base)), effective: rate(ent), used: DASH, resets: DASH },
    {
      key: "video", label: t.video, plan: models(base.media.video),
      override: g ? (
        <span className={g.expired ? "text-muted opacity-60" : ""} data-testid="video-grant" data-expired={g.expired ? "true" : "false"}>
          {t.all} {t.until} <Ltr>{g.until}</Ltr> · {t.by} <Ltr>{g.by}</Ltr>{g.note ? ` · ${g.note}` : ""}
          {g.expired && <span className="ms-1 rounded bg-ink/10 px-1 font-semibold">{t.expired}</span>}
        </span>
      ) : DASH,
      effective: models(ent.media.video), used: DASH, resets: DASH,
    },
    { key: "agents", label: t.agents, plan: agents(base), override: differs(agents(ent), agents(base)), effective: agents(ent), used: DASH, resets: DASH },
    { key: "status", label: t.status, plan: status(base), override: statusText(ent) === statusText(base) ? DASH : <>{status(ent)} · {t.noEnd}</>, effective: status(ent), used: DASH, resets: DASH },
  ];

  return (
    <div className="rounded border border-ink/10 p-2" data-testid="entitlements">
      <p className="text-muted">{t.title}</p>
      <div className="overflow-x-auto">
        <table className="mt-1 w-full text-start font-mono text-xs">
          <thead>
            <tr className="text-muted">
              {[t.dimension, t.plan, t.override, t.effective, t.used, t.resets].map((h) => <th key={h} className="p-1 text-start font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-ink/5 align-top" data-row={r.key}>
                <td className="p-1 font-sans">{r.label}</td>
                <td className="p-1">{r.plan}</td>
                <td className="p-1">{r.override}</td>
                <td className="p-1 font-semibold">{r.effective}</td>
                <td className="p-1">{r.used}</td>
                <td className="p-1">{r.resets === DASH ? DASH : <Ltr>{r.resets}</Ltr>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
