import type { ReactNode } from "react";
import { agentById } from "@/lib/agents";
import { mediaModel, type VideoModelId } from "@/lib/media-catalog";
// Type only: src/lib/entitlements.ts reaches the store (rate.ts, team.ts, chat-allowance.ts), so it is never imported at
// runtime here or in AdminConsole (rule 781, tests/entitlements-scan.test.ts); the type is erased from the bundle.
import type { EntitlementView } from "@/lib/entitlements";

/**
 * The founder's entitlements table for one account (spec 6.1, rule 784): one row per dimension, with the plan's own
 * value, the founder's override (value, until, who, note), the effective value, what is used and when it resets. Every
 * figure comes from `view` (`entitlementView`), none is worked out here.
 *
 * The view carries one dated override, the video grant, so that is the only row with an override cell. The deal, seat
 * and chat overrides (no end date) are folded into the effective numbers and set from the account's own controls, so the
 * Plan cell of those three rows is a dash rather than a number that would be wrong whenever an override is set. A grant
 * that has run out is greyed and marked "expired": the effective value is then the plan's own list.
 */
const T = {
  en: {
    title: "Entitlements", dimension: "Dimension", plan: "Plan", override: "Override", effective: "Effective", used: "Used", resets: "Resets",
    credits: "Credits per month", seats: "Seats", chatMonth: "Chat messages (month)", chatTrial: "Chat messages (trial)", chatRate: "Chat rate (hour / day)",
    video: "Video models", agents: "Agents", status: "Active / ends",
    balance: "balance", noEnd: "no end date", active: "active", expired: "expired", until: "until", by: "by", all: "all models",
    inactive: { suspended: "suspended", trial_over: "trial over", billing_locked: "billing locked" },
    note: "Credits, seats and chat month: the deal, seat and chat overrides are set from the account's controls and are inside the effective number.",
  },
  ar: {
    title: "الاستحقاقات", dimension: "البند", plan: "الخطة", override: "التخصيص", effective: "الفعلي", used: "المستخدم", resets: "يتجدد",
    credits: "الكريدت الشهري", seats: "المقاعد", chatMonth: "رسائل الدردشة (الشهر)", chatTrial: "رسائل الدردشة (التجربة)", chatRate: "سقف الدردشة (ساعة / يوم)",
    video: "نماذج الفيديو", agents: "الوكلاء", status: "مفعّل / ينتهي",
    balance: "الرصيد", noEnd: "بلا تاريخ انتهاء", active: "مفعّل", expired: "منتهية", until: "حتى", by: "بواسطة", all: "كل النماذج",
    inactive: { suspended: "موقوف", trial_over: "انتهت التجربة", billing_locked: "الدفع مقفل" },
    note: "الكريدت والمقاعد ورسائل الدردشة الشهرية: تخصيصات العقد والمقاعد والدردشة تُضبط من أدوات الحساب وهي داخل الرقم الفعلي.",
  },
} as const;

/** One row of the table. A cell is text, or a node for the override (an expired grant is greyed there). */
type Row = { key: string; label: string; plan: string; override: ReactNode; effective: string; used: string; resets: string };

const DASH = "—";

export default function EntitlementsTable({ view, lang }: { view: EntitlementView; lang: "ar" | "en" }) {
  const t = T[lang];
  const { ent, used, resetsAt, grants } = view;
  const g = grants.video;
  const models = (ids: readonly VideoModelId[]) => ids.map((id) => mediaModel(id).label[lang]).join(", ");
  const agents = ent.agents.map((id) => agentById(id).name[lang]).join(", ");
  const monthly = used.chat.period === "month";

  const rows: Row[] = [
    { key: "credits", label: t.credits, plan: DASH, override: DASH, effective: String(ent.credits.monthly), used: `${t.balance} ${used.credits}`, resets: resetsAt ?? DASH },
    { key: "seats", label: t.seats, plan: DASH, override: DASH, effective: String(ent.seats), used: `${used.seats} / ${ent.seats}`, resets: DASH },
    { key: "chat", label: monthly ? t.chatMonth : t.chatTrial, plan: DASH, override: DASH, effective: String(ent.chat.monthly), used: `${used.chat.counted} / ${used.chat.allowance}`, resets: monthly ? resetsAt ?? DASH : DASH },
    { key: "rate", label: t.chatRate, plan: `${ent.chat.hour} / ${ent.chat.day}`, override: DASH, effective: `${ent.chat.hour} / ${ent.chat.day}`, used: DASH, resets: DASH },
    {
      key: "video", label: t.video,
      // Without a grant, or with a spent one, the effective list is the plan's own. A live grant hides the plan's list from this view.
      plan: !g || g.expired ? models(ent.media.video) : DASH,
      override: g ? (
        <span className={g.expired ? "text-muted opacity-60" : ""} data-testid="video-grant" data-expired={g.expired ? "true" : "false"}>
          {t.all} {t.until} <span dir="ltr">{g.until}</span> · {t.by} <span dir="ltr">{g.by}</span>{g.note ? ` · ${g.note}` : ""}
          {g.expired && <span className="ms-1 rounded bg-ink/10 px-1 font-semibold">{t.expired}</span>}
        </span>
      ) : DASH,
      effective: models(ent.media.video), used: DASH, resets: DASH,
    },
    { key: "agents", label: t.agents, plan: agents, override: DASH, effective: agents, used: DASH, resets: DASH },
    {
      key: "status", label: t.status, plan: DASH, override: DASH,
      effective: [ent.active ? t.active : t.inactive[ent.inactive ?? "suspended"], ent.endsAt ? ent.endsAt.slice(0, 10) : t.noEnd].join(" · "),
      used: DASH, resets: DASH,
    },
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
                <td className="p-1" dir="ltr">{r.resets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-muted">{t.note}</p>
    </div>
  );
}
