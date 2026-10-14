import { CHAT_ALLOWANCE, PLAN_CREDITS } from "./pricing";

type L = { ar: string; en: string };

/**
 * What the signup page tells a new owner happens next (rule 1847). Every line is a step the product really takes, in
 * order: the address is proved first (flows.md section 1, rule 754), the start page asks a few quick questions and
 * confirms the site (section 6 steps 1-2), and Noor builds the brand file and the first plan from the site or the
 * answers (section 6 steps 4-6); nothing is published without the owner's approval (section 9). The trial's chat
 * messages and credits come from `src/lib/pricing.ts`. The page imports this module, not the whole dictionary.
 */
export const SIGNUP_NEXT: { reads: L; h: L; steps: { ar: readonly string[]; en: readonly string[] }; trial: L } = {
  reads: { ar: "نور بتقرا:", en: "Noor will read:" },
  h: { ar: "وش يصير في الدقايق الجاية", en: "What happens in the next few minutes" },
  steps: {
    ar: [
      "تأكد إيميلك من رابط نرسله لك.",
      "تجاوب على أسئلة سريعة عن محلك وتأكد رابطك.",
      "نور تبني ملف علامتك وأول خطة، وما ينشر شي بدون موافقتك.",
    ],
    en: [
      "You confirm your email from a link we send you.",
      "You answer a few quick questions about your business and confirm your link.",
      "Noor builds your brand file and first plan, and nothing is published without your approval.",
    ],
  },
  trial: {
    ar: `ومعك في التجربة ${CHAT_ALLOWANCE.trial} رسالة محادثة مع الفريق و${PLAN_CREDITS.trial} كريدت.`,
    en: `Your trial includes ${CHAT_ALLOWANCE.trial} chat messages with the team and ${PLAN_CREDITS.trial} credits.`,
  },
};

/**
 * The site the visitor typed on the home page, as it is shown back to them (rule 1847): only something shaped like a
 * web address (a host with a dot, an optional path), without its scheme, cut to 60 characters. Anything else shows
 * nothing, so a crafted link cannot put a sentence of its own on the signup page.
 */
export function shownSite(raw: string): string {
  const v = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(\/[^\s]*)?$/u.test(v)) return "";
  return v.length > 60 ? `${v.slice(0, 59)}…` : v;
}
