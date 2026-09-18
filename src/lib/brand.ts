import { db } from "./db";
import { pmap } from "./parallel";

export type Brand = {
  name: string;
  website: string;
  industry: string;
  dialect: "msa" | "saudi" | "emirati" | "kuwaiti" | "english";
  languages: ("ar" | "en")[];
  tone: string;
  products: string;
  audience: string;
  offers: string;
  competitors: string;
  banned: string;
  preferred: string;
  channels: string[];
  city: string;
  updatedAt: string;
  /** Why customers choose you (profile page). */
  valueProp?: string;
  /** Sitemap URL for internal links and product import. */
  sitemap?: string;
  /** Social handles by platform (instagram, snapchat, tiktok, x, linkedin). */
  social?: Record<string, string>;
};

export type TaskType =
  | "weekly_plan" | "social" | "article" | "whatsapp" | "ads" | "gbp"
  | "sales_script" | "lead_qualifier" | "followup_seq"
  | "pricing_review" | "unit_economics" | "cash_forecast"
  | "gtm_plan" | "growth_experiments" | "retention_play"
  | "weekly_report" | "board_deck" | "dashboard_spec"
  | "strategy_review" | "okrs" | "decision_memo"
  | "prd" | "roadmap" | "feedback_synthesis" | "onboarding_flow";

/** Credits per batch. */
export const TASK_COST: Record<TaskType, number> = {
  weekly_plan: 1, social: 10, article: 2, whatsapp: 3, ads: 5, gbp: 3,
  sales_script: 4, lead_qualifier: 2, followup_seq: 3,
  pricing_review: 4, unit_economics: 3, cash_forecast: 4,
  gtm_plan: 5, growth_experiments: 4, retention_play: 4,
  weekly_report: 2, board_deck: 5, dashboard_spec: 2,
  strategy_review: 5, okrs: 3, decision_memo: 3,
  prd: 4, roadmap: 4, feedback_synthesis: 3, onboarding_flow: 3,
};
/** Items produced per batch. */
export const TASK_COUNT: Record<TaskType, number> = {
  weekly_plan: 1, social: 10, article: 1, whatsapp: 3, ads: 5, gbp: 3,
  sales_script: 3, lead_qualifier: 1, followup_seq: 7,
  pricing_review: 1, unit_economics: 1, cash_forecast: 1,
  gtm_plan: 1, growth_experiments: 5, retention_play: 3,
  weekly_report: 1, board_deck: 1, dashboard_spec: 1,
  strategy_review: 1, okrs: 1, decision_memo: 1,
  prd: 1, roadmap: 1, feedback_synthesis: 1, onboarding_flow: 1,
};
/** Types that get a generated image button in the inbox. */
export const IMAGE_TYPES: TaskType[] = ["social", "ads", "gbp", "whatsapp"];

export type Task = {
  id: string;
  type: TaskType;
  channel: string;
  title: string;
  body: string;
  editedBody?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  lang: "ar" | "en";
  source?: "manual" | "chat" | "scheduled";
  scheduledFor?: string; // YYYY-MM-DD, set by owner in inbox/calendar
  imageUrl?: string;
  imagePrompt?: string;
  published?: { provider: string; url: string; status: "draft" | "published"; at: string }[];
  /** When the owner approved or rejected (for time-to-decision). */
  decidedAt?: string;
  /** Automated judge score (src/lib/judge.ts). */
  quality?: { score: number; dims: { completeness: number; brand: number; honesty: number; language: number; format: number }; notes: string; model: string; at: string };
};
export const IMAGE_COST = 1;

export async function getBrand(email: string) {
  return db.get<Brand>(`brand:${email}`);
}
export async function saveBrand(email: string, b: Brand) {
  await db.set(`brand:${email}`, b);
}
export async function listTasks(email: string): Promise<Task[]> {
  const ids = await db.lrange(`tasks:${email}`, 0, 199);
  // Parallel reads: 200 sequential round trips made every page that lists tasks slow.
  const rows = await pmap(ids, (id) => db.get<Task>(`task:${email}:${id}`));
  return rows.filter((t): t is Task => !!t);
}
export async function saveTask(email: string, t: Task, isNew = false) {
  await db.set(`task:${email}:${t.id}`, t);
  if (isNew) await db.lpush(`tasks:${email}`, t.id);
}
export async function getTask(email: string, id: string) {
  return db.get<Task>(`task:${email}:${id}`);
}
export async function addPreference(email: string, note: string) {
  await db.lpush(`prefs:${email}`, note.slice(0, 500));
}
export async function listPreferences(email: string) {
  return db.lrange(`prefs:${email}`, 0, 29);
}
