/**
 * One switch for every Claude call in the product: chat, generation and its reviewer, the judge, onboarding, image
 * prompts, the free tools and the golden set.
 *
 * Paused on 2026-09-28 at the owner's request. To turn Claude back on, set CLAUDE_PAUSED to false and deploy.
 *
 * Paused is not the no-key development path. Without ANTHROPIC_API_KEY (outside a Vercel production deployment, which
 * refuses as paused instead: `modelState`) the app answers with [DEV MOCK] placeholders,
 * which is right on a laptop and in CI and wrong for a customer: the mock items would be charged for, and onboarding
 * would save a mock brand file that then blocks the real onboarding. Paused surfaces refuse instead, before a credit
 * moves or anything is written.
 */
export const CLAUDE_PAUSED = true;

export type ModelState = "on" | "paused" | "mock";

/**
 * "mock" only where no customer can be: no key and not a Vercel production deployment (a laptop, vitest, CI, the e2e
 * suite). A production deployment without ANTHROPIC_API_KEY answers "paused", so every surface refuses before a credit
 * moves (rule 76) and no [DEV MOCK] item, chat reply or brand file is ever saved for a customer. Rule 321,
 * tests/launch-security.test.ts.
 */
export function modelState(): ModelState {
  if (!process.env.ANTHROPIC_API_KEY) {
    if (process.env.VERCEL_ENV === "production") {
      warnNoKey();
      return "paused";
    }
    return "mock";
  }
  return CLAUDE_PAUSED ? "paused" : "on";
}

let warned = false;
/** One log line per instance naming the missing variable (never a value), so the cause is visible in the logs. */
function warnNoKey() {
  if (warned) return;
  warned = true;
  console.error("model_not_configured: ANTHROPIC_API_KEY is not set in production; the agents refuse as paused");
}

/** Thrown by the model-backed helpers while paused. A backstop: every caller that charges first refunds on a throw. */
export class ModelPaused extends Error {
  constructor() {
    super("model_paused");
    this.name = "ModelPaused";
  }
}

/** The chat reply while paused, in the reader's language. Agent-neutral, since any of the agents can be the one asked. */
export const PAUSED_REPLY = {
  ar: "الوكلاء متوقفون مؤقتاً، فلا أستطيع الرد أو إنشاء محتوى الآن. لم يُخصم أي كريدت.",
  en: "The agents are paused for now, so I can't reply or create content yet. No credits were used.",
} as const;
