"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { settingsHref } from "@/lib/settings-nav";
import { Field, Input, Select } from "@/components/ui/Field";
import Callout from "@/components/ui/Callout";
import SettingsCard, { type CardStatus } from "./SettingsCard";
import ThemeToggle from "@/components/ui/ThemeToggle";
import { THEME_COPY } from "@/lib/theme";
import { readProfile, saveProfile } from "./profileSave";
import EmailChange from "./EmailChange";
import { useBrandId, useWsHandle } from "@/components/app/WorkspaceContext";
import { appHref } from "@/lib/ws-path";
import { WORKSPACE_NAME_MAX, cleanWorkspaceName } from "@/lib/workspace-name";

/** The account values the page renders with: the acting person's name and language, and the account's phone (owner only). */
export type AccountInitial = { name: string; email: string; lang: Lang; phone?: string; owner: boolean; canChangeEmail?: boolean; workspaceName?: string };

/** At least 9 digits: the phone check PUT /api/profile makes. */
export const phoneValid = (v: string) => v.replace(/\D/g, "").length >= 9;

const COPY = {
  ar: {
    save: "حفظ", saving: "يحفظ…", saved: "تم الحفظ.",
    name: "الاسم الكامل", nameSub: "يظهر لفريقك وفي رسائل الوكلاء إليك.", nameEmpty: "اكتب اسمك.",
    lang: "لغة التطبيق", langOwner: "لغة التطبيق والإيميلات", langSub: "تتغيّر الواجهة فور الحفظ.", langOwnerSub: "لغة الواجهة ولغة إيميلات الحساب والفوترة.",
    phone: "رقم الجوال", phoneSub: "رقم الحساب للتواصل والتفعيل. 9 أرقام على الأقل.", phoneBad: "اكتب 9 أرقام على الأقل.",
    phoneMissing: "أضف رقم جوالك: حفظ أي بطاقة أخرى هنا يحتاجه.",
    email: "البريد", emailSub: "اسم دخولك. تقدر تغيّره هنا برمز يوصل للبريد الجديد.", emailSubLocked: "اسم دخولك.",
    ws: "اسم مساحة العمل", wsSub: "يظهر في قائمة مساحات العمل وفي الدعوات ولفريقك. رابط المساحة لا يتغيّر.",
    wsEmpty: "اكتب اسمًا لمساحة العمل.", wsLong: `الاسم أطول من ${WORKSPACE_NAME_MAX} حرفًا.`, wsSlow: "غيّرت الاسم مرات كثيرة. حاول بعد ساعة.", wsBusy: "الحساب مشغول بتغيير آخر الآن. حاول بعد لحظات.", wsFailed: "تعذّر الحفظ، حاول مرة أخرى.",
  },
  en: {
    save: "Save", saving: "Saving…", saved: "Saved.",
    name: "Full name", nameSub: "Shown to your team and in your agents' messages to you.", nameEmpty: "Enter your name.",
    lang: "App language", langOwner: "App and email language", langSub: "The app switches as soon as you save.", langOwnerSub: "The app's language and the language of account and billing emails.",
    phone: "Mobile number", phoneSub: "The account's contact and activation number. At least 9 digits.", phoneBad: "Use at least 9 digits.",
    phoneMissing: "Add your mobile number: saving any other card here needs it.",
    email: "Email", emailSub: "Your login. You can change it here with a code sent to the new address.", emailSubLocked: "Your login.",
    ws: "Workspace name", wsSub: "Shown in the workspace list, in invitations and to your team. The workspace's link does not change.",
    wsEmpty: "Enter a name for the workspace.", wsLong: `The name is longer than ${WORKSPACE_NAME_MAX} characters.`, wsSlow: "You renamed it many times. Try again in an hour.", wsBusy: "The account is busy with another change. Try again in a moment.", wsFailed: "Could not save. Try again.",
  },
} as const;

/**
 * Settings, Account (rules 1142-1143): the name, the language and, for the owner, the account's phone, each in its own
 * card with its own Save, which stays off until the value is changed and can be saved. The email card changes the
 * sign-in address through POST /api/account/email (`EmailChange`, rules 1942-1945), never through PUT /api/profile.
 * Every card sends only its own field to PUT /api/profile, which checks the role for each field as before. The owner
 * also gets the workspace name card (rules 3115-3118), saved through PUT /api/account/workspace, which checks the role
 * again on the server and answers with the name as stored.
 */
export default function AccountSettings({ lang, initial, forbidden }: { lang: Lang; initial: AccountInitial; forbidden: string }) {
  const r = useRouter();
  const T = COPY[lang];
  const handle = useWsHandle();
  const [stored, setStored] = useState(initial);
  const [name, setName] = useState(initial.name);
  const sessionBrand = useBrandId();
  const [ui, setUi] = useState<Lang>(initial.lang);
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [ws, setWs] = useState(initial.workspaceName ?? "");
  const [busy, setBusy] = useState<"" | "name" | "lang" | "phone" | "ws">("");
  const [status, setStatus] = useState<Record<string, CardStatus>>({});
  const say = (k: string, s: CardStatus) => setStatus((p) => ({ ...p, [k]: s }));

  async function save(k: "name" | "lang" | "phone", value: string) {
    setBusy(k); say(k, null);
    const out = await saveProfile({ [k]: value }, lang, forbidden, sessionBrand);
    setBusy("");
    if (out.kind === "saved") {
      const next = { ...stored, name: out.saved.me.name, lang: out.saved.me.lang, ...(out.saved.phone !== undefined ? { phone: out.saved.phone } : {}) };
      setStored(next);
      if (k === "name") setName(next.name);
      if (k === "phone") setPhone(next.phone ?? "");
      say(k, { tone: "ok", text: T.saved });
      // A new language is a new address: the page in the language just chosen.
      if (k === "lang" && next.lang !== lang) { r.push(settingsHref((p) => appHref(next.lang, p, handle), "account")); return; }
      r.refresh();
      return;
    }
    say(k, { tone: "error", text: out.text });
    if (out.kind === "unknown") {
      // The save may have landed in part: show what is stored, never what was typed.
      const fresh = await readProfile().catch(() => null);
      if (fresh?.ok && fresh.me) {
        const next = { ...stored, name: fresh.me.name, lang: fresh.me.lang, ...(stored.owner ? { phone: fresh.user?.phone ?? "" } : {}) };
        setStored(next); setName(next.name); setUi(next.lang); setPhone(next.phone ?? "");
      }
    }
  }

  /** Rename the workspace (rule 3115): the server cleans and checks the name again and answers with what it stored. */
  async function saveWs(value: string) {
    setBusy("ws"); say("ws", null);
    try {
      const res = await fetch("/api/account/workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: value }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; error?: string };
      if (res.ok && j.ok && typeof j.name === "string") {
        setStored((p) => ({ ...p, workspaceName: j.name }));
        setWs(j.name);
        say("ws", { tone: "ok", text: T.saved });
        r.refresh();
      } else {
        const text = res.status === 403 ? forbidden : res.status === 429 ? T.wsSlow : j.error === "busy" ? T.wsBusy : j.error === "too_long" ? T.wsLong : j.error === "required" ? T.wsEmpty : T.wsFailed;
        say("ws", { tone: "error", text });
      }
    } catch {
      say("ws", { tone: "error", text: T.wsFailed });
    }
    setBusy("");
  }

  const wsCheck = cleanWorkspaceName(ws);
  const nameT = name.trim();
  const phoneT = phone.trim();
  const phoneMissing = stored.owner && !phoneValid(stored.phone ?? "");
  return (
    <div className="grid gap-4">
      {phoneMissing && <Callout tone="notice">{T.phoneMissing}</Callout>}
      <SettingsCard title={T.name} sub={T.nameSub} onSave={() => save("name", nameT)} dirty={nameT !== stored.name} valid={nameT.length > 0} busy={busy === "name"} status={status.name ?? null} saveLabel={T.save} savingLabel={T.saving}>
        <Field label={T.name} hideLabel required error={nameT ? undefined : name !== stored.name ? T.nameEmpty : undefined}>
          <Input name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />
        </Field>
      </SettingsCard>

      {stored.owner && (
        <SettingsCard title={T.ws} sub={T.wsSub} onSave={() => { if (wsCheck.ok) void saveWs(wsCheck.name); }} dirty={(wsCheck.ok ? wsCheck.name : ws) !== (stored.workspaceName ?? "")} valid={wsCheck.ok} busy={busy === "ws"} status={status.ws ?? null} saveLabel={T.save} savingLabel={T.saving}>
          <Field label={T.ws} hideLabel required error={wsCheck.ok || ws === (stored.workspaceName ?? "") ? undefined : wsCheck.error === "too_long" ? T.wsLong : T.wsEmpty}>
            <Input name="workspaceName" value={ws} onChange={(e) => setWs(e.target.value)} autoComplete="organization" maxLength={WORKSPACE_NAME_MAX} dir="auto" />
          </Field>
        </SettingsCard>
      )}

      <SettingsCard title={stored.owner ? T.langOwner : T.lang} sub={stored.owner ? T.langOwnerSub : T.langSub} onSave={() => save("lang", ui)} dirty={ui !== stored.lang} busy={busy === "lang"} status={status.lang ?? null} saveLabel={T.save} savingLabel={T.saving}>
        <Field label={stored.owner ? T.langOwner : T.lang} hideLabel>
          <Select name="lang" value={ui} onChange={(e) => setUi(e.target.value === "en" ? "en" : "ar")}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
        </Field>
      </SettingsCard>

      {/* Rule 1204: the theme is this browser's, applied at once; no Save and nothing sent to the server. */}
      <SettingsCard title={THEME_COPY[lang].title} sub={THEME_COPY[lang].sub}>
        <ThemeToggle lang={lang} className="justify-self-start" />
      </SettingsCard>

      {stored.owner && (
        <SettingsCard title={T.phone} sub={T.phoneSub} onSave={() => save("phone", phoneT)} dirty={phoneT !== (stored.phone ?? "")} valid={phoneValid(phoneT)} busy={busy === "phone"} status={status.phone ?? null} saveLabel={T.save} savingLabel={T.saving}>
          <Field label={T.phone} hideLabel required error={phoneT && !phoneValid(phoneT) ? T.phoneBad : undefined}>
            <Input name="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={30} />
          </Field>
        </SettingsCard>
      )}

      <SettingsCard title={T.email} sub={stored.canChangeEmail ? T.emailSub : T.emailSubLocked} status={status.email ?? null}>
        <p className="tnum font-medium text-foreground" dir="ltr">{stored.email}</p>
        {stored.canChangeEmail && <EmailChange lang={lang} forbidden={forbidden} onStatus={(s) => say("email", s)} />}
      </SettingsCard>
    </div>
  );
}
