import { db } from "./db";

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
};

export type TaskType = "weekly_plan" | "social" | "article" | "whatsapp" | "ads" | "gbp";

export const TASK_COST: Record<TaskType, number> = { weekly_plan: 1, social: 10, article: 2, whatsapp: 3, ads: 5, gbp: 3 };

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
  const out: Task[] = [];
  for (const id of ids) {
    const t = await db.get<Task>(`task:${email}:${id}`);
    if (t) out.push(t);
  }
  return out;
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
