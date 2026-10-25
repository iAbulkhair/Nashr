/**
 * The welcome notice (rule 3506): one in-app notification when a person signs up for the first time, in the language
 * they signed up in. Called from the two sign-up paths only (the password form `POST /api/auth/signup` and Google's
 * `created` branch), never from a team join or a second workspace (`createWorkspace`), which make no first sign-up.
 *
 * No duplicate on retry: the bell's own fingerprint claim (`pushNotif`, SET NX `notifseen:{account}:welcome`) is taken
 * once per account, kept a year, and deleted with the account (`wipeAccount`) so a new account at the same address is
 * welcomed again. A failure is logged and never fails the sign-up.
 */
import type { User } from "./auth";
import { acct } from "./account-id";
import { log } from "./log";
import { pushNotif, type Notif } from "./notifications";
import { appHrefFor } from "./ws-href";

export const WELCOME_FP = "welcome";
/** How long the claim lasts: long past any retry; the account wipe deletes it earlier. */
export const WELCOME_TTL_DAYS = 365;

/** The notice for an account in its language. Plain words, no promise of results. */
export function welcomeNotice(u: Pick<User, "id" | "email" | "lang">): Omit<Notif, "id" | "at"> {
  const ar = u.lang !== "en";
  return {
    kind: "info",
    href: appHrefFor(u, u.lang, "/start", "default"),
    title: ar ? "أهلاً بك في ذكين" : "Welcome to Thakeen",
    body: ar ? "ابدأ بملف علامتك التجارية: أخبر الفريق عن نشاطك وجمهورك، ثم اطلب أول دفعة محتوى." : "Start with your brand file: tell the team about your business and audience, then ask for your first batch of content.",
  };
}

/** Rule 3506: push the welcome once. Answers whether this call pushed it. Never throws. */
export async function welcomeOnSignup(u: Pick<User, "id" | "email" | "lang">): Promise<boolean> {
  try {
    return !!(await pushNotif(acct(u), welcomeNotice(u), WELCOME_FP, WELCOME_TTL_DAYS));
  } catch (e) {
    log.error("welcome notice failed", { err: e instanceof Error ? e.name : "error" });
    return false;
  }
}
