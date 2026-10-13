import { adminEmails } from "./auth";
import { mailReady, sendEmail } from "./notify";

/**
 * The founder alert for a break-glass staff change (rule 1643): every `staff.reset` and `staff.enable` done from the key
 * session mails each `ADMIN_EMAILS` address, so a stolen key that takes over a staff login is seen at once. This is the
 * alert role `ADMIN_EMAILS` keeps after the contract release.
 *
 * The mail names the action, the staff address and the time only: never the setup code, a password, a secret or the
 * reason text. It goes to the founders, never to the staff address: there is still no email in any staff recovery path.
 * Nothing is sent when mail is not configured (`mailReady`); a failed send changes nothing (the audit row is the record).
 */
export type KeyStaffAction = "reset" | "enable";

export function keyStaffAlert(action: KeyStaffAction, target: string, at = new Date()): { subject: string; text: string } {
  const when = at.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const ar = action === "reset" ? "إعادة تعيين دخول موظف" : "إعادة تفعيل حساب موظف";
  const en = action === "reset" ? "a staff login was reset" : "a staff login was enabled again";
  return {
    subject: `Thakeen console: ${en} from the key session`,
    text: [
      `تنبيه من لوحة المؤسس في ذكين: ${ar} من جلسة المفتاح (باب الطوارئ).`,
      `الحساب: ${target}`,
      `الوقت: ${when}`,
      "إن لم تكن أنت: غيّر مفتاح اللوحة فورًا، وأعد تعيين هذا الحساب من حساب موظف مالك، وراجع سجل اللوحة.",
      "",
      `Thakeen founder console alert: ${en} from the key session (break-glass).`,
      `Login: ${target}`,
      `Time: ${when}`,
      "If this was not you: change the console key now, reset this login from a staff owner, and check the console log.",
    ].join("\n"),
  };
}

/** Mail every founder address; resolves either way. */
export async function alertFoundersKeyStaff(action: KeyStaffAction, target: string): Promise<void> {
  if (!mailReady()) return;
  const { subject, text } = keyStaffAlert(action, target);
  await Promise.all(adminEmails().map((to) => sendEmail(to, subject, text).catch(() => false)));
}
