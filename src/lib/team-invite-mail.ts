import type { Invite } from "./team";

const ROLE = { ar: { admin: "مدير", member: "عضو" }, en: { admin: "admin", member: "member" } } as const;

/**
 * The invitation email, in the invite's language. A fixed template: the only thing in it the sender chose is the
 * address of the login that sent it (a validated email, no spaces or line breaks). No display name and no brand name:
 * both are free text anyone can set at signup or on the brand form, and they would turn this email, sent from the
 * product's own verified domain to any address, into a relay for whatever text the sender wanted to put in it. The HTML
 * part (src/emails/team-invite.ts) takes the same three values and nothing else (rule 688); `sendEmail` renders it from
 * `context` (rule 1962). Shared by POST /api/team/invite and the console's workspace edit (rule 3553), which passes the
 * account owner's address: support acts for the owner, and the email never names a staff member.
 */
export function inviteMail(inv: Invite, inviterEmail: string, link: string) {
  const context = { inviterEmail, role: inv.role, link };
  if (inv.lang === "ar") {
    return {
      subject: "دعوة للانضمام إلى فريق في ذكين",
      text: `مرحباً،\n\nدعاك مستخدم ذكين ${inviterEmail} للانضمام إلى حسابه في ذكين بصفة ${ROLE.ar[inv.role]}.\n\nافتح الرابط التالي خلال 7 أيام لتختار اسمك وكلمة مرورك:\n\n${link}\n\nالدعوة لهذا البريد وحده. إذا لم تتوقعها فتجاهل هذه الرسالة، ولن يتغير شيء.`,
      context,
    };
  }
  return {
    subject: "You are invited to join a team on Thakeen",
    text: `Hello,\n\nThe Thakeen user ${inviterEmail} invited you to join their account on Thakeen as ${inv.role === "admin" ? "an admin" : "a member"}.\n\nOpen this link within 7 days to choose your name and password:\n\n${link}\n\nThe invitation is for this email address only. If you did not expect it, ignore this email and nothing changes.`,
    context,
  };
}
