/**
 * One switch for every Claude call in the product: chat, generation and its reviewer, the judge, onboarding, image
 * prompts, the free tools and the golden set.
 *
 * Paused on 2026-09-28 at the owner's request. To turn Claude back on, set CLAUDE_PAUSED to false and deploy.
 *
 * Paused is not the no-key development path. Without ANTHROPIC_API_KEY the app answers with [DEV MOCK] placeholders,
 * which is right on a laptop and in CI and wrong for a customer: the mock items would be charged for, and onboarding
 * would save a mock brand file that then blocks the real onboarding. Paused surfaces refuse instead, before a credit
 * moves or anything is written.
 */
export const CLAUDE_PAUSED = true;

export type ModelState = "on" | "paused" | "mock";

export function modelState(): ModelState {
  if (!process.env.ANTHROPIC_API_KEY) return "mock";
  return CLAUDE_PAUSED ? "paused" : "on";
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
