import { createHash, randomBytes } from "crypto";
import { resetPassword } from "../emails";
import { getLogin } from "./auth";
import { db } from "./db";
import { globalKey } from "./keys";
import { sendEmail } from "./notify";
import { appOrigin } from "./origin";

/** What a reset token resets: the login it was issued for (read back in src/app/api/auth/reset/route.ts). */
export type ResetRecord = { email: string; kind: "owner" | "member" };

/** One reset link lives an hour. */
export const RESET_TTL_SECONDS = 3600;

/**
 * Mail a one-hour, single-use reset link to `email` when it is a login (rule 3101: one writer for POST /api/auth/forgot
 * and the signed-in "set a password" card, POST /api/account/password-link). The caller has already checked mail
 * delivery (`mailReady`) and its rate limits; for the card the address is the session's own login, never one from the
 * request. A member whose account is gone has nothing to sign in to and gets no link. The link names the PERSON's address
 * (multi-workspace M1, rule 2132): the reset route writes the person's password with `updatePerson`, for a legacy login
 * and a `p_` person alike. The token is stored hashed and rides in the URL fragment (#t=), never a query string, so it
 * stays out of server, proxy and edge logs and the Referer header (rule 546). Answers whether a link was sent.
 */
export async function mailResetLink(email: string, lang: "ar" | "en"): Promise<boolean> {
  const login = await getLogin(email);
  const target: ResetRecord | null = !login ? null : login.kind === "owner" ? { email: login.person.email, kind: "owner" } : login.owner ? { email: login.person.email, kind: "member" } : null;
  if (!target) return false;
  const token = randomBytes(32).toString("hex");
  await db.set(globalKey.passwordReset(createHash("sha256").update(token).digest("hex")), target, RESET_TTL_SECONDS);
  const link = `${appOrigin()}/${lang}/app/reset#t=${token}`;
  // The text part stays as it was; the HTML part (src/emails/reset-password.ts) says the same in the shared layout.
  return sendEmail(target.email, lang === "ar" ? "إعادة تعيين كلمة المرور في ذكين" : "Reset your Thakeen password", lang === "ar"
    ? `مرحباً،\n\nوصلنا طلب لإعادة تعيين كلمة مرور حسابك في ذكين. افتح الرابط التالي خلال ساعة واحدة:\n\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغير شيء.`
    : `Hello,\n\nWe received a request to reset your Thakeen password. Open this link within one hour:\n\n${link}\n\nIf you did not ask for this, ignore this email and nothing changes.`, resetPassword({ lang, link }));
}
