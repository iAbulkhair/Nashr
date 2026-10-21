"use client";
import { useState, Suspense } from "react";
import type { Lang } from "@/lib/i18n";
import { passwordChecks } from "@/lib/auth-client";
import { Field } from "@/components/ui/Field";
import PasswordField from "../PasswordField";
import { PasswordRules } from "../PasswordRules";
import ReadOnlyNote from "../ReadOnlyNote";
import SettingsCard, { type CardStatus } from "./SettingsCard";
import TwoStepSettings from "./TwoStepSettings";
import DeviceList from "./DeviceList";
import GoogleLink from "./GoogleLink";
import PasskeySettings from "./PasskeySettings";
import type { AppDict } from "@/lib/app-i18n";

const COPY = {
  ar: {
    pw: "كلمة المرور", pwSub: "بعد التغيير تخرج أجهزتك الأخرى، ويبقى هذا الجهاز.", pwOwnerSub: "بعد التغيير تخرج أجهزتك الأخرى، وتتوقف مفاتيح المساعد الذكي والتطبيقات المربوطة ورابط التقويم ورابط الحجز. يبقى هذا الجهاز.",
    current: "كلمة المرور الحالية", next: "كلمة المرور الجديدة", change: "غيّر كلمة المرور", changing: "يغيّر…",
    changed: "تم تغيير كلمة المرور.", wrong: "كلمة المرور الحالية غير صحيحة. لم يتغيّر شيء.", weak: "كلمة المرور الجديدة لا تحقق الشروط. لم يتغيّر شيء.",
    others: "الخروج من الأجهزة الأخرى", othersSub: "تخرج كل جلسة أخرى لحسابك في متصفح آخر أو جهاز آخر، ويبقى هذا الجهاز. لا تتأثر مفاتيح المساعد الذكي ولا التطبيقات المربوطة ولا رابط التقويم ولا روابط الحجز.",
    othersBtn: "اخرج من الأجهزة الأخرى", othersBusy: "يُخرج…", othersDone: "خرجت أجهزتك الأخرى. يبقى هذا الجهاز.", confirmPw: "كلمة المرور للتأكيد",
    slow: "محاولات كثيرة في وقت قصير. حاول بعد ساعة.", failed: "تعذّر ذلك. حاول مرة أخرى.",
    founder: "تغيير كلمة المرور والخروج من الأجهزة الأخرى والدخول بخطوتين ومفاتيح المرور موقوفة أثناء تصفّح هذا الحساب كمؤسس.",
  },
  en: {
    pw: "Password", pwSub: "Changing it signs your other devices out; this one stays signed in.", pwOwnerSub: "Changing it signs your other devices out and ends your AI-assistant keys, connected apps, calendar feed and booking links. This device stays signed in.",
    current: "Current password", next: "New password", change: "Change password", changing: "Changing…",
    changed: "Password changed.", wrong: "The current password is wrong. Nothing changed.", weak: "The new password does not meet the rules. Nothing changed.",
    others: "Sign out other devices", othersSub: "Ends every other session of your login, in another browser or on another device; this one stays signed in. AI-assistant keys, connected apps, the calendar feed and booking links are not affected.",
    othersBtn: "Sign out other devices", othersBusy: "Signing out…", othersDone: "Your other devices are signed out. This one stays signed in.", confirmPw: "Password to confirm",
    slow: "Too many tries in a short time. Try again in an hour.", failed: "That did not work. Try again.",
    founder: "Changing the password, signing out other devices, two-step sign-in and passkeys are off while you view this account as the founder.",
  },
} as const;

/**
 * Settings, Security (rules 1150-1151): the password change with the sign-up rules shown live as they are met (the
 * same `passwordChecks` and words as signup, reset and the invite form), two-step sign-in (rules 1930-1937,
 * `TwoStepSettings`), passkeys (rules 2410-2416, 2426, 2429, `PasskeySettings`), and "sign out other devices" with the device list (rules 1938-1941, `DeviceList`, which uses the
 * same password field to sign one device out). Each is its own card; none keeps a typed password once it is sent.
 * `may`: from `can()` on the server (a founder viewing the account may do none of them).
 */
export default function SecuritySettings({ lang, rules, may, owner, forbidden, passkeys }: { lang: Lang; rules: readonly string[]; may: boolean; owner: boolean; forbidden: string; passkeys: { T: AppDict["passkeys"]; enabled: boolean } }) {
  const T = COPY[lang];
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState<"" | "pw" | "others">("");
  const [pwStatus, setPwStatus] = useState<CardStatus>(null);
  const [confirm, setConfirm] = useState("");
  const [othersStatus, setOthersStatus] = useState<CardStatus>(null);
  const [devicesRefresh, setDevicesRefresh] = useState(0);
  if (!may) return <ReadOnlyNote className="" text={T.founder} />;
  const checks = passwordChecks(pw);
  const ready = checks.every(Boolean);

  async function change() {
    setBusy("pw"); setPwStatus(null);
    const res = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: cur, newPassword: pw }) }).catch(() => null);
    const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; error?: string };
    setBusy("");
    setCur(""); setPw("");
    setPwStatus(j.ok ? { tone: "ok", text: T.changed }
      : { tone: "error", text: res?.status === 403 ? forbidden : j.error === "wrong_password" ? T.wrong : j.error === "weak_password" ? T.weak : T.failed });
  }
  async function signOutOthers() {
    setBusy("others"); setOthersStatus(null);
    const res = await fetch("/api/account/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: confirm }) }).catch(() => null);
    const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; error?: string };
    setBusy("");
    setConfirm("");
    setDevicesRefresh((n) => n + 1);
    setOthersStatus(j.ok ? { tone: "ok", text: T.othersDone }
      : { tone: "error", text: res?.status === 403 ? forbidden : res?.status === 429 ? T.slow : j.error === "wrong_password" ? T.wrong : T.failed });
  }

  return (
    <div className="grid gap-4">
      <SettingsCard title={T.pw} sub={owner ? T.pwOwnerSub : T.pwSub} onSave={change} dirty={cur.length > 0 && pw.length > 0} valid={ready} busy={busy === "pw"} status={pwStatus} saveLabel={T.change} savingLabel={T.changing}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={T.current} required>
            <PasswordField lang={lang} name="currentPassword" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
          </Field>
          <Field label={T.next} required>
            <PasswordField lang={lang} name="newPassword" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="settings-pw-rules" />
            <PasswordRules id="settings-pw-rules" rules={rules} checks={checks} lang={lang} />
          </Field>
        </div>
      </SettingsCard>

      <TwoStepSettings lang={lang} forbidden={forbidden} />
      <PasskeySettings lang={lang} T={passkeys.T} enabled={passkeys.enabled} forbidden={forbidden} />
      <Suspense><GoogleLink lang={lang} forbidden={forbidden} /></Suspense>

      <SettingsCard title={T.others} sub={T.othersSub} onSave={signOutOthers} dirty={confirm.length > 0} busy={busy === "others"} status={othersStatus} saveLabel={T.othersBtn} savingLabel={T.othersBusy}>
        <Field label={T.confirmPw} required className="sm:max-w-sm">
          <PasswordField lang={lang} name="password" autoComplete="current-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <DeviceList lang={lang} password={confirm} onUsed={() => setConfirm("")} forbidden={forbidden} refresh={devicesRefresh} />
      </SettingsCard>
    </div>
  );
}
