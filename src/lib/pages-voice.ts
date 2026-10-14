import type { Lang } from "./i18n";

/**
 * The words around the sector pages (/for/*) and the team pages (/agents, /agents/{agent}) in the home page's voice
 * (rule 1862, site critique 2026-10-14): short, warm, light Saudi dialect in Arabic («وش», «يسوي», «لو عندك…»), plain
 * English of the same length beside it. Every line says what the product does today; the agents' own lines come from
 * `AGENT_CAST` in src/lib/home.ts, which ties each question to a task the agent owns. Type-only import: no data module
 * is pulled in.
 */

export const FOR_VOICE: Record<Lang, { pains: string; does: (agent: string) => string; team: string; others: string }> = {
  ar: { pains: "وش يصير اليوم", does: (agent) => `وش تسوي ${agent}`, team: "الفريق معك", others: "قطاعات ثانية:" },
  en: { pains: "What happens today", does: (agent) => `What ${agent} does`, team: "The team with you", others: "Other industries:" },
};

export const AGENTS_VOICE: Record<Lang, { title: string; sub: string; does: string; works: string; asks: string; onMind: string; others: string; startWith: string }> = {
  ar: {
    title: "ثمانية وكلاء، ومحادثة وحدة.",
    sub: "تبدأ مع نور. هي تعرف علامتك، ولو احتجت متخصص تناديه لك في نفس المحادثة.",
    does: "وش تستلم",
    works: "كيف يمشي الشغل",
    asks: "جرّب تطلب",
    onMind: "اللي يدور في بالك",
    others: "باقي الفريق",
    startWith: "نفس المحادثة ونفس ملف العلامة. ابدأ مع",
  },
  en: {
    title: "Eight agents, one chat.",
    sub: "You start with Noor. She knows your brand, and when you need a specialist she brings them into the same chat.",
    does: "What you get",
    works: "How the work goes",
    asks: "Try asking",
    onMind: "What's on your mind",
    others: "The rest of the team",
    startWith: "Same chat, same brand file. Start with",
  },
};
