"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { settingsHref } from "@/lib/settings-nav";
import Button from "@/components/ui/Button";
import { buttonClass } from "@/components/ui/button-class";
import DeleteAccountDialog from "../DeleteAccountDialog";
import LogoutButton from "../LogoutButton";
import ReadOnlyNote from "../ReadOnlyNote";
import SettingsCard from "./SettingsCard";

const COPY = {
  ar: {
    logout: "تسجيل الخروج", logoutSub: "تخرج من هذا الجهاز فقط.",
    del: "حذف الحساب", delSub: "يحذف حسابك وكل علاماته وملفاته ومحادثاته نهائياً. لا رجوع.", delBtn: "احذف حسابي",
    founder: "حذف الحساب موقوف أثناء تصفّح هذا الحساب كمؤسس.",
    leave: "مغادرة الفريق", leaveSub: "تخرج من هذا الحساب ويبقى عمل الفريق كما هو. تجد زر المغادرة في صفحة الأعضاء.", leaveBtn: "إلى الأعضاء",
    noExport: "لا يوجد تصدير ذاتي لبيانات الحساب بعد. لنسخة من بياناتك قبل الحذف تواصل مع الدعم.",
  },
  en: {
    logout: "Log out", logoutSub: "Signs you out on this device only.",
    del: "Delete account", delSub: "Permanently deletes your account with all its brands, files and conversations. This cannot be undone.", delBtn: "Delete my account",
    founder: "Deleting the account is off while you view it as the founder.",
    leave: "Leave the team", leaveSub: "You leave this account; the team's work stays as it is. The Leave button is on the Members page.", leaveBtn: "Go to Members",
    noExport: "There is no self-serve export of account data yet. For a copy of your data before deleting, contact support.",
  },
} as const;

/**
 * Settings, Danger zone (rule 1149): log out here, and for the owner, delete the account in the app's own dialog (it asks
 * for the password and the typed email, rule 964); a founder viewing the account never gets the delete button, and
 * DELETE /api/account refuses it anyway. A member leaves the team from the Members page, where the leave confirm lives.
 */
export default function DangerZone({ lang, email, canDelete, impersonating, owner, logoutLabel, failText }: { lang: Lang; email: string; canDelete: boolean; impersonating: boolean; owner: boolean; logoutLabel: string; failText: { forbidden: string; failed: string } }) {
  const r = useRouter();
  const T = COPY[lang];
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="grid gap-4">
      <SettingsCard title={T.logout} sub={T.logoutSub}>
        <div><LogoutButton label={logoutLabel} lang={lang} className={buttonClass({ variant: "secondary", size: "sm" })} /></div>
      </SettingsCard>

      {owner ? (
        <SettingsCard title={T.del} sub={T.delSub} tone="danger">
          {impersonating || !canDelete ? (
            <ReadOnlyNote className="" text={T.founder} />
          ) : (
            <>
              <p className="text-sm text-foreground-muted">{T.noExport}</p>
              <div>
                <Button variant="danger" size="sm" aria-haspopup="dialog" onClick={() => setDeleting(true)}>{T.delBtn}</Button>
              </div>
              {deleting && <DeleteAccountDialog lang={lang} email={email} onClose={() => setDeleting(false)} onDeleted={() => { r.push(`/${lang}`); r.refresh(); }} failText={(status) => (status === 403 ? failText.forbidden : failText.failed)} />}
            </>
          )}
        </SettingsCard>
      ) : (
        <SettingsCard title={T.leave} sub={T.leaveSub}>
          <div><Link href={settingsHref(lang, "members")} className={buttonClass({ variant: "secondary", size: "sm" })}>{T.leaveBtn}</Link></div>
        </SettingsCard>
      )}
    </div>
  );
}
