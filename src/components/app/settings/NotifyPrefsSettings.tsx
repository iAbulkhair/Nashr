"use client";
import { useState } from "react";
import Link from "next/link";
import type { Lang } from "@/lib/i18n";
import type { EmailLevel, EmailTopic, InAppTopic, NotifyPrefs } from "@/lib/notify-prefs";
import Switch from "@/components/ui/Switch";
import ReadOnlyNote from "../ReadOnlyNote";
import SettingsCard, { type CardStatus } from "./SettingsCard";

type Row = { key: string; name: string; sub: string; inApp: InAppTopic | "always" | "with-reminders" | null; email: EmailTopic | "always" | null };

const COPY = {
  ar: {
    save: "حفظ", saving: "يحفظ…", saved: "تم الحفظ.", failed: "تعذّر الحفظ. لم يتغيّر شيء، حاول مرة أخرى.", slow: "حفظات كثيرة في وقت قصير. حاول بعد قليل.", forbidden: "تفضيلات التنبيه لمالك الحساب.",
    brief: "ملخص نور الصباحي بالبريد", briefSub: "يصل كل صباح، مع ما ينتظرك من متابعات.",
    levels: { all: ["كل يوم", "ملخص كل صباح."], important: ["عند وجود ما يحتاجك فقط", "حين ينتظر شيء موافقتك أو مهمة موعدها اليوم أو فات."], none: ["لا", "لا يصلك الملخص بالبريد."] } as Record<EmailLevel, [string, string]>,
    matrix: "التنبيهات حسب النوع", matrixSub: "اختر لكل نوع: داخل التطبيق (الجرس)، بالبريد، أو كليهما.",
    type: "النوع", inApp: "داخل التطبيق", email: "البريد", always: "دائماً", na: "—", withReminders: "مع التذكيرات",
    rows: {
      reminders: ["تذكيرات ريم", "تذكير بمهمة طلبته، ومهام فات موعدها."],
      evening: ["ملخص ريم المسائي", "ما أُنجز اليوم وما بقي للغد."],
      approvals: ["بانتظار موافقتك", "عناصر تنتظرك منذ أكثر من يومين."],
      schedule: ["موعد النشر", "عناصر موعدها اليوم أو غداً."],
      reports: ["الخطط والتقارير", "خطة الأسبوع وما يشبهها."],
      updates: ["تحديثات الفريق", "الجودة، وانتهاء صورة أو فيديو، وانضمام عضو."],
      account: ["الحساب والرصيد", "الرصيد المنخفض ونهاية التجربة. تصل دائماً."],
    } as Record<string, [string, string]>,
    memberNote: "يختار مالك الحساب هذه التنبيهات، وتصل إلى بريده.",
    feed: "كل التنبيهات",
  },
  en: {
    save: "Save", saving: "Saving…", saved: "Saved.", failed: "Could not save. Nothing changed; try again.", slow: "Many saves in a short time. Try again shortly.", forbidden: "Notification preferences are the account owner's.",
    brief: "Noor's morning brief by email", briefSub: "Arrives each morning, with any follow-ups waiting for you.",
    levels: { all: ["Every day", "A brief every morning."], important: ["Only when something needs me", "When something waits for your approval, or a to-do is due today or overdue."], none: ["Never", "No brief by email."] } as Record<EmailLevel, [string, string]>,
    matrix: "Notifications by type", matrixSub: "For each type choose: in the app (the bell), by email, or both.",
    type: "Type", inApp: "In the app", email: "Email", always: "Always", na: "—", withReminders: "With reminders",
    rows: {
      reminders: ["Reem's reminders", "A reminder you asked for, and overdue to-dos."],
      evening: ["Reem's evening wrap", "What got done today and what is left for tomorrow."],
      approvals: ["Waiting for your approval", "Items waiting for you for more than two days."],
      schedule: ["Due to publish", "Items due today or tomorrow."],
      reports: ["Plans and reports", "The weekly plan and the like."],
      updates: ["Team updates", "Quality notes, a finished image or video, a member joining."],
      account: ["Account and credits", "Low credits and the trial's end. Always sent."],
    } as Record<string, [string, string]>,
    memberNote: "The account owner chooses these notifications; they reach the owner's email.",
    feed: "All notifications",
  },
} as const;

const ROWS: Omit<Row, "name" | "sub">[] = [
  { key: "reminders", inApp: "reminders", email: "reminders" },
  { key: "evening", inApp: "with-reminders", email: "evening" },
  { key: "approvals", inApp: "approvals", email: null },
  { key: "schedule", inApp: "schedule", email: null },
  { key: "reports", inApp: "reports", email: null },
  { key: "updates", inApp: "updates", email: null },
  { key: "account", inApp: "always", email: "always" },
];

const same = (a: NotifyPrefs, b: NotifyPrefs) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Settings, Notifications (rules 1144-1148): Noor's brief by email at one of three levels, as before, and a table of
 * the other notices by type and channel. Two cards, each with its own Save; each save sends the whole set of choices,
 * its own card's changes on top of what is stored, so one card never saves the other's unsaved edits. `canEdit`: the
 * owner (`profile.account`); anyone else sees the choices and who makes them.
 */
export default function NotifyPrefsSettings({ lang, initial, canEdit }: { lang: Lang; initial: NotifyPrefs; canEdit: boolean }) {
  const T = COPY[lang];
  const [stored, setStored] = useState(initial);
  const [brief, setBrief] = useState<EmailLevel>(initial.brief);
  const [grid, setGrid] = useState({ email: initial.email, inApp: initial.inApp });
  const [busy, setBusy] = useState<"" | "brief" | "grid">("");
  const [status, setStatus] = useState<{ brief: CardStatus; grid: CardStatus }>({ brief: null, grid: null });

  async function save(card: "brief" | "grid") {
    const next: NotifyPrefs = card === "brief" ? { ...stored, brief } : { ...stored, email: grid.email, inApp: grid.inApp };
    setBusy(card); setStatus((s) => ({ ...s, [card]: null }));
    const res = await fetch("/api/notifications/prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; prefs?: NotifyPrefs };
    setBusy("");
    if (res?.ok && j.ok && j.prefs) {
      setStored(j.prefs);
      setStatus((s) => ({ ...s, [card]: { tone: "ok", text: T.saved } }));
      return;
    }
    const text = res?.status === 403 ? T.forbidden : res?.status === 429 ? T.slow : T.failed;
    setStatus((s) => ({ ...s, [card]: { tone: "error", text } }));
  }

  const flip = (ch: "email" | "inApp", k: string, v: boolean) => setGrid((g) => ({ ...g, [ch]: { ...g[ch], [k]: v } }));
  const cell = (row: Omit<Row, "name" | "sub">, ch: "email" | "inApp", rowName: string) => {
    const v = row[ch];
    if (v === null) return <span className="text-foreground-muted" aria-label={lang === "ar" ? "غير متاح" : "Not offered"}>{T.na}</span>;
    if (v === "always") return <span className="text-sm text-foreground-muted">{T.always}</span>;
    if (v === "with-reminders") return <span className="text-xs text-foreground-muted">{T.withReminders}</span>;
    const on = ch === "email" ? grid.email[v as EmailTopic] : grid.inApp[v as InAppTopic];
    return <Switch checked={on} onChange={(n) => flip(ch, v, n)} disabled={!canEdit} label={`${rowName}: ${ch === "email" ? T.email : T.inApp}`} />;
  };

  return (
    <div className="grid gap-4">
      {!canEdit && <ReadOnlyNote className="" text={T.memberNote} />}
      <SettingsCard title={T.brief} sub={T.briefSub} onSave={canEdit ? () => save("brief") : undefined} dirty={brief !== stored.brief} busy={busy === "brief"} status={status.brief} saveLabel={T.save} savingLabel={T.saving}>
        <fieldset disabled={!canEdit} className="grid gap-2">
          <legend className="sr-only">{T.brief}</legend>
          {(["all", "important", "none"] as const).map((v) => (
            <label key={v} className="flex min-h-[var(--hit-min)] cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-ink">
              <input type="radio" name="brief" value={v} checked={brief === v} onChange={() => setBrief(v)} className="mt-1" />
              <span><span className="block font-semibold text-ink">{T.levels[v][0]}</span><span className="block text-sm text-foreground-muted">{T.levels[v][1]}</span></span>
            </label>
          ))}
        </fieldset>
      </SettingsCard>

      <SettingsCard title={T.matrix} sub={T.matrixSub} onSave={canEdit ? () => save("grid") : undefined} dirty={!same({ ...stored, email: grid.email, inApp: grid.inApp }, stored)} busy={busy === "grid"} status={status.grid} saveLabel={T.save} savingLabel={T.saving}>
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <thead>
              <tr className="text-xs text-foreground-muted">
                <th scope="col" className="px-1 py-2 text-start font-semibold">{T.type}</th>
                <th scope="col" className="w-24 px-1 py-2 text-center font-semibold">{T.inApp}</th>
                <th scope="col" className="w-24 px-1 py-2 text-center font-semibold">{T.email}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const [name, sub] = T.rows[row.key];
                return (
                  <tr key={row.key} className="border-t border-border">
                    <th scope="row" className="px-1 py-2 text-start font-normal">
                      <span className="block font-semibold text-ink">{name}</span>
                      <span className="block text-xs text-foreground-muted">{sub}</span>
                    </th>
                    <td className="px-1 py-2 text-center">{cell(row, "inApp", name)}</td>
                    <td className="px-1 py-2 text-center">{cell(row, "email", name)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsCard>
      <p className="text-sm"><Link href={`/${lang}/app/notifications`} className="font-medium text-ink underline underline-offset-4">{T.feed}</Link></p>
    </div>
  );
}
