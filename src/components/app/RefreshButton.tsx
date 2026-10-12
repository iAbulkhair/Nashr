"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { limitFromError } from "./LimitModal";

/**
 * The Reports page's read buttons (spec section 8): "Refresh" for the site (`sync_site`, rule 735) and the social parts
 * (`sync_social`), free and open to any member, and "Refresh X (1 credit)" (`sync_x`, rule 744), paid by the account.
 * The route checks the role, the hourly limit and the charge; these only post the action and say what the answer means.
 * Every message is a constant here: nothing from the answer but its codes reaches the page.
 */
const STR = {
  ar: {
    social: "حدّث", site: "حدّث", x: "حدّث إكس (رصيد واحد)", reading: "جارٍ القراءة…",
    done: "قُرئت الآن.", nothing: "لم يُقرأ شيء: أعد ربط حساباتك من صفحة التكاملات.",
    reconnectOne: "قُرئ الباقي. أعد ربط {name} من صفحة التكاملات.",
    xDone: "قُرئ إكس وخُصم رصيد واحد.", xFree: "قُرئ إكس اليوم من قبل، فلم يُخصم رصيد.",
    slowDown: "تحديثات كثيرة. حاول بعد ساعة.", trialOver: "انتهت الفترة التجريبية: اختر خطة لتحديث إكس.",
    noCredits: "رصيدك لا يكفي لتحديث إكس.", agentCap: "بلغت دانة سقف رصيدها لهذا الشهر.",
    xUnavailable: "إكس غير متاح الآن. حاول لاحقاً.", xDirectOnly: "نقرأ إكس من ربطه المباشر فقط. اربطه مباشرة من صفحة التكاملات.",
    notConnected: "غير مربوط. اربطه من صفحة التكاملات.", reconnect: "انتهت صلاحية الربط: أعد ربطه من صفحة التكاملات.",
    forbidden: "دورك في الحساب لا يسمح بهذا.", failed: "تعذّرت القراءة. حاول لاحقاً.",
    saved: "حُفظ اختيارك، وأرقامه تُقرأ الآن.", savedLater: "حُفظ اختيارك، وتأتي أرقامه مع القراءة القادمة.",
    notListed: "هذا الخيار ليس في القائمة. أعد ربط Google لتحديثها.", ownerOnly: "يغيّره المالك أو المشرف فقط.", notSaved: "لم يُحفظ اختيارك. حاول لاحقاً.",
    providers: { meta: "إنستقرام وفيسبوك", linkedin: "لينكدإن", youtube: "يوتيوب", tiktok: "تيك توك", google: "Google", x: "إكس" } as Record<string, string>,
  },
  en: {
    social: "Refresh", site: "Refresh", x: "Refresh X (1 credit)", reading: "Reading…",
    done: "Read just now.", nothing: "Nothing was read: connect your accounts again on the Integrations page.",
    reconnectOne: "The rest was read. Connect {name} again on the Integrations page.",
    xDone: "X was read. One credit was used.", xFree: "X was already read today, so no credit was used.",
    slowDown: "Too many refreshes. Try again in an hour.", trialOver: "The trial is over: choose a plan to refresh X.",
    noCredits: "Not enough credits to refresh X.", agentCap: "Dana has reached her credit cap for this month.",
    xUnavailable: "X is not available right now. Try again later.", xDirectOnly: "X is read only through its own direct connection. Connect it directly on the Integrations page.",
    notConnected: "Not connected. Connect it on the Integrations page.", reconnect: "The connection expired: connect it again on the Integrations page.",
    forbidden: "Your role in this account does not allow this.", failed: "The read failed. Try again later.",
    saved: "Saved. Its figures are being read now.", savedLater: "Saved. Its figures come with the next read.",
    notListed: "This choice is not on the list. Connect Google again to refresh it.", ownerOnly: "Only the owner or an admin can change this.", notSaved: "The choice was not saved. Try again later.",
    providers: { meta: "Instagram and Facebook", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok", google: "Google", x: "X" } as Record<string, string>,
  },
} as const;

export type RefreshKind = "social" | "site" | "x";
const ACTION: Record<RefreshKind, string> = { social: "sync_social", site: "sync_site", x: "sync_x" };
type Answer = { ok?: boolean; read?: boolean; reconnect?: string; charged?: boolean; error?: string };

/**
 * What a refresh's answer means, in the viewer's language. `noCredits` is the out-of-credits line that fits the role and
 * the plan (`noCreditsText`, rule 457); a status of 0 is a request that never got an answer.
 */
export function refreshNote(lang: Lang, kind: RefreshKind, status: number, j: Answer, noCredits?: string): string {
  const S = STR[lang];
  if (j.ok) {
    if (kind === "x") return j.charged === false ? S.xFree : S.xDone;
    if (j.reconnect) return S.reconnectOne.replace("{name}", S.providers[j.reconnect] ?? j.reconnect);
    return j.read === false ? S.nothing : S.done;
  }
  switch (j.error) {
    case "slow_down": return S.slowDown;
    case "trial_over": return S.trialOver;
    case "no_credits": return noCredits || S.noCredits;
    case "agent_cap": return S.agentCap;
    case "x_unavailable": return S.xUnavailable;
    case "x_direct_only": return S.xDirectOnly;
    case "not_connected": return S.notConnected;
    case "reconnect_required": return S.reconnect;
    case "forbidden": return S.forbidden;
  }
  return status === 403 ? S.forbidden : S.failed;
}

/** What the answer to a property or site choice (`select_property`, rule 734) means: saved and read now, or saved and read later. */
export function selectNote(lang: Lang, status: number, j: Answer): string {
  const S = STR[lang];
  if (j.ok) return j.read === false ? S.savedLater : S.saved;
  if (j.error === "unknown_property" || j.error === "bad_value") return S.notListed;
  if (j.error === "forbidden" || status === 403) return S.ownerOnly;
  if (j.error === "not_connected") return S.notConnected;
  if (j.error === "reconnect_required") return S.reconnect;
  return S.notSaved;
}

/**
 * One read button. `path` is the connect route's provider (a constant, or a provider of the workspace's own records);
 * the page reloads its data after an answer that read something.
 */
export default function RefreshButton({ lang, kind, path, noCredits }: { lang: Lang; kind: RefreshKind; path: string; noCredits?: string }) {
  const r = useRouter();
  const S = STR[lang];
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function go() {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(`/api/connect/${encodeURIComponent(path)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: ACTION[kind] }) });
      const j = (await res.json().catch(() => ({}))) as Answer;
      if (!j.ok) limitFromError(j.error);
      setNote(refreshNote(lang, kind, res.status, j, noCredits));
      if (j.ok) r.refresh();
    } catch {
      setNote(refreshNote(lang, kind, 0, {}, noCredits));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={go} disabled={busy} className="btn btn-secondary btn-xs">{busy ? S.reading : S[kind]}</button>
      {note && <span role="status" className="text-xs text-foreground-muted" dir="auto">{note}</span>}
    </span>
  );
}
