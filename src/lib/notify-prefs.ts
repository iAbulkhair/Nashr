import { db } from "./db";
import type { NotifKind } from "./notifications";

/**
 * Notification preferences per type and channel (UI/UX phase 3, rules 1144-1148), stored where the email preference has
 * always lived: `profile:{scope}` (the brand's; the account's `profile:{email}` when the brand has none).
 *
 * Stored shape, expand step (rule 679): `{ emails, notify? }`.
 * - `emails` ("all" | "important" | "none") is the old field. Every reader before this release reads only it, and this
 *   release still writes it on every save, derived from the new choices (`legacyEmails`), so a rollback finds the
 *   nearest old level and keeps working.
 * - `notify` ({ v: 1, brief, email, inApp }) is new. Old code ignores it. A save of the old field alone (PUT /api/profile
 *   `emails`, which old and new code both answer by writing `{ emails }`) drops it on purpose: the old choice then rules
 *   again, read through `prefsFrom` exactly as before.
 * Contract step (a later release): readers drop the `emails` fallback once every stored record carries `notify`; that
 * needs an idempotent script that writes `notify` from `emails` where it is missing, run after this release is live.
 */
export type EmailLevel = "all" | "important" | "none";
export const EMAIL_LEVELS: readonly EmailLevel[] = ["all", "important", "none"];

/** Bell entries a person can switch off, by group. Account notices (credits, trial) are not here: they always arrive. */
export const IN_APP_TOPICS = ["reminders", "approvals", "schedule", "reports", "updates"] as const;
export type InAppTopic = (typeof IN_APP_TOPICS)[number];
/** Emails a person can switch off besides Noor's brief (which has three levels, as before). */
export const EMAIL_TOPICS = ["reminders", "evening"] as const;
export type EmailTopic = (typeof EMAIL_TOPICS)[number];

export type NotifyPrefs = { brief: EmailLevel; email: Record<EmailTopic, boolean>; inApp: Record<InAppTopic, boolean> };
export type StoredNotify = { v: 1; brief?: EmailLevel; email?: Partial<Record<EmailTopic, boolean>>; inApp?: Partial<Record<InAppTopic, boolean>> };
export type StoredProfile = { emails?: EmailLevel; notify?: StoredNotify };

/** Which switch governs a bell entry of each kind; null = always delivered. */
export const KIND_TOPIC: Record<NotifKind, InAppTopic | null> = {
  todo: "reminders", pending: "approvals", due: "schedule", weekly: "reports", quality: "updates", info: "updates", credits: null, trial: null,
};

const isLevel = (v: unknown): v is EmailLevel => typeof v === "string" && (EMAIL_LEVELS as readonly string[]).includes(v);

/**
 * The old level's meaning, unchanged: "all" sends every email; "important" sends the brief only when something waits and
 * still sends reminders, never the evening wrap; "none" sends none of them. Every bell entry arrives.
 */
export function prefsFromLevel(level: EmailLevel): NotifyPrefs {
  return {
    brief: level,
    email: { reminders: level !== "none", evening: level === "all" },
    inApp: { reminders: true, approvals: true, schedule: true, reports: true, updates: true },
  };
}

/** The preferences a stored record means: the new shape when it is there, else the old field, else everything on. */
export function prefsFrom(stored: StoredProfile | null | undefined): NotifyPrefs {
  const level: EmailLevel = isLevel(stored?.emails) ? stored!.emails! : "all";
  const base = prefsFromLevel(level);
  const n = stored?.notify;
  if (!n || n.v !== 1) return base;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    brief: isLevel(n.brief) ? n.brief : base.brief,
    email: { reminders: bool(n.email?.reminders, base.email.reminders), evening: bool(n.email?.evening, base.email.evening) },
    inApp: Object.fromEntries(IN_APP_TOPICS.map((k) => [k, bool(n.inApp?.[k], true)])) as Record<InAppTopic, boolean>,
  };
}

/**
 * The old field to write next to the new shape: "none" when no email is on, "all" when every one is, else "important".
 * It only decides anything if this release is rolled back; `prefsFrom` maps each old level back to itself.
 */
export function legacyEmails(p: NotifyPrefs): EmailLevel {
  if (p.brief === "none" && !p.email.reminders && !p.email.evening) return "none";
  if (p.brief === "all" && p.email.reminders && p.email.evening) return "all";
  return "important";
}

/** What a save writes: both shapes, so old and new code read the same choice. */
export const storedFrom = (p: NotifyPrefs): Required<StoredProfile> => ({
  emails: legacyEmails(p),
  notify: { v: 1, brief: p.brief, email: { ...p.email }, inApp: { ...p.inApp } },
});

/** Parse a request body into preferences, or null when any part is missing or of the wrong type. */
export function parsePrefs(b: unknown): NotifyPrefs | null {
  if (!b || typeof b !== "object") return null;
  const o = b as { brief?: unknown; email?: Record<string, unknown>; inApp?: Record<string, unknown> };
  if (!isLevel(o.brief) || !o.email || typeof o.email !== "object" || !o.inApp || typeof o.inApp !== "object") return null;
  if (!EMAIL_TOPICS.every((k) => typeof o.email![k] === "boolean")) return null;
  if (!IN_APP_TOPICS.every((k) => typeof o.inApp![k] === "boolean")) return null;
  return {
    brief: o.brief,
    email: Object.fromEntries(EMAIL_TOPICS.map((k) => [k, o.email![k] as boolean])) as Record<EmailTopic, boolean>,
    inApp: Object.fromEntries(IN_APP_TOPICS.map((k) => [k, o.inApp![k] as boolean])) as Record<InAppTopic, boolean>,
  };
}

/** May a bell entry of this kind be stored? Account notices always are. */
export const inAppAllowed = (p: NotifyPrefs, kind: NotifKind) => {
  const topic = KIND_TOPIC[kind];
  return topic === null || topic === undefined || p.inApp[topic];
};

/** May this email go? `important`: the brief has something waiting (an approval, a follow-up, a to-do due). */
export function emailAllowed(p: NotifyPrefs, what: "brief" | EmailTopic, important = false): boolean {
  if (what === "brief") return p.brief === "all" || (p.brief === "important" && important);
  return p.email[what];
}

export const profileKey = (scope: string) => `profile:${scope}`;
/** A record that says something (old or new field), so a brand's empty record falls back to the account's. */
const said = (r: StoredProfile | null | undefined): StoredProfile | null => (r && (r.emails !== undefined || r.notify !== undefined) ? r : null);

/** Each scope's preferences in one read (`profile:{scope}`, else the account's `profile:{email}`). */
export async function readPrefsMany(scopes: string[], email: string): Promise<Map<string, NotifyPrefs>> {
  const uniq = [...new Set(scopes)];
  const rows = await db.mget<StoredProfile>([...uniq.map(profileKey), profileKey(email)]);
  const account = said(rows[uniq.length]);
  return new Map(uniq.map((s, i) => [s, prefsFrom(said(rows[i]) ?? account)]));
}

export async function readPrefs(scope: string, email: string): Promise<NotifyPrefs> {
  return (await readPrefsMany([scope], email)).get(scope)!;
}
