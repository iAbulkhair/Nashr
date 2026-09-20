import { CAPS, db, pushCapped } from "./db";
import { pmap } from "./parallel";
import { similarity } from "./similarity";

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

// The task catalogue lives in ./tasks, which imports nothing: client components read the costs from there instead of
// from this module, which would drag the Redis client into their bundle. Re-exported so server callers are unaffected.
export type { TaskType } from "./tasks";
export { TASK_COST, TASK_COUNT, IMAGE_TYPES, IMAGE_COST } from "./tasks";
import type { TaskType } from "./tasks";

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

/**
 * Light row of a task: everything the dashboards, calendar, briefs and metrics need, without the body. Rows live in one
 * Redis hash per workspace per creation month (`tidx:{scope}:{YYYY-MM}`), so a page costs one command per month it looks
 * at instead of one per task, and nothing falls off after the 200 newest tasks.
 */
export type TaskLite = Pick<Task, "id" | "type" | "channel" | "title" | "status" | "createdAt" | "lang" | "source" | "scheduledFor" | "decidedAt"> & {
  /** First 200 characters of the current text (edited text when the owner edited it). */
  preview: string;
  edited: boolean;
  /** How much the owner changed the text before approving, 0..100. Only set when edited. */
  editPct?: number;
  image: boolean;
  published: number;
  score?: number;
  notes?: string;
};
export function liteOf(t: Task): TaskLite {
  const edited = !!t.editedBody && t.editedBody !== t.body;
  return {
    id: t.id, type: t.type, channel: t.channel, title: t.title, status: t.status, createdAt: t.createdAt, lang: t.lang, source: t.source, scheduledFor: t.scheduledFor, decidedAt: t.decidedAt,
    preview: (t.editedBody ?? t.body ?? "").slice(0, 200),
    edited,
    editPct: edited ? Math.round((1 - similarity(t.body, t.editedBody!)) * 100) : undefined,
    image: !!t.imageUrl,
    published: t.published?.length ?? 0,
    score: t.quality?.score,
    notes: t.quality?.notes?.slice(0, 200),
  };
}
const monthOf = (iso: string) => (/^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : "0000-00");
const asLite = (v: unknown): TaskLite | null => {
  if (typeof v !== "string") return (v as TaskLite) ?? null;
  try { return JSON.parse(v) as TaskLite; } catch { return null; }
};

export async function saveTask(email: string, t: Task, isNew = false) {
  const month = monthOf(t.createdAt);
  // Every path that changes a task goes through here, and each write below is idempotent, so the pending set and the
  // light index cannot drift the way a +1/-1 counter would. One round of parallel commands instead of a chain.
  await Promise.all([
    db.set(`task:${email}:${t.id}`, t),
    isNew ? db.lpush(`tasks:${email}`, t.id) : null,
    t.status === "pending" ? db.sadd(`pending:${email}`, t.id) : db.srem(`pending:${email}`, t.id),
    db.hset(`tidx:${email}:${month}`, t.id, liteOf(t)),
    db.sadd(`tidxm:${email}`, month),
  ]);
}

/** Rebuild the light index from the stored tasks (first use on an existing workspace, and the weekly reconcile). */
export async function rebuildIndex(email: string): Promise<TaskLite[]> {
  const ids = await db.lrange(`tasks:${email}`, 0, -1);
  const rows = (await pmap(ids, (id) => db.get<Task>(`task:${email}:${id}`))).filter((t): t is Task => !!t);
  const lite = rows.map(liteOf);
  await pmap(lite, (l) => db.hset(`tidx:${email}:${monthOf(l.createdAt)}`, l.id, l));
  await Promise.all([...new Set(lite.map((l) => monthOf(l.createdAt)))].map((m) => db.sadd(`tidxm:${email}`, m)));
  await db.set(`tidxv:${email}`, new Date().toISOString());
  return lite.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
/** When the light index was last rebuilt from the tasks themselves, or null when it never was. */
export async function indexedAt(email: string) {
  return db.get<string>(`tidxv:${email}`);
}

/** Light rows, newest first. `since` limits the read to the months that can hold tasks created on or after it. */
export async function listLite(email: string, since?: Date): Promise<TaskLite[]> {
  const [marker, months] = await Promise.all([db.get<string>(`tidxv:${email}`), db.smembers(`tidxm:${email}`)]);
  if (!marker) {
    const all = await rebuildIndex(email);
    return since ? all.filter((l) => new Date(l.createdAt) >= since) : all;
  }
  const from = since ? since.toISOString().slice(0, 7) : "";
  const maps = await Promise.all(months.filter((m) => m >= from).map((m) => db.hgetall<unknown>(`tidx:${email}:${m}`)));
  const out: TaskLite[] = [];
  for (const map of maps) for (const v of Object.values(map)) { const l = asLite(v); if (l && (!since || new Date(l.createdAt) >= since)) out.push(l); }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Light rows created in the last `days` days (server components may not read the clock themselves). */
export const listLiteDays = (email: string, days: number) => listLite(email, new Date(Date.now() - days * 864e5));

/** Rebuild the pending set from the task list (first use on an existing workspace, and the daily reconcile). */
export async function rebuildPending(email: string, tasks?: Pick<Task, "id" | "status">[]): Promise<number> {
  const list = tasks ?? (await listLite(email));
  const want = new Set(list.filter((t) => t.status === "pending").map((t) => t.id));
  const have = await db.smembers(`pending:${email}`);
  await Promise.all([...have.filter((id) => !want.has(id)).map((id) => db.srem(`pending:${email}`, id)), ...[...want].filter((id) => !have.includes(id)).map((id) => db.sadd(`pending:${email}`, id))]);
  await db.set(`pendingidx:${email}`, new Date().toISOString());
  return want.size;
}

/** Number of items waiting for the owner's approval: one read once the workspace has been indexed. */
export async function pendingCount(email: string): Promise<number> {
  if (!(await db.get(`pendingidx:${email}`))) return rebuildPending(email);
  return (await db.smembers(`pending:${email}`)).length;
}
export async function getTask(email: string, id: string) {
  return db.get<Task>(`task:${email}:${id}`);
}
export async function addPreference(email: string, note: string) {
  await pushCapped(`prefs:${email}`, note.slice(0, 500), CAPS.prefs);
}
export async function listPreferences(email: string) {
  return db.lrange(`prefs:${email}`, 0, 29);
}
