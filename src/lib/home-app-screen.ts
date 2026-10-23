import { AGENTS } from "./agents";
import type { Lang } from "./i18n";
import { roleMeets, type Action } from "./roles";

/**
 * The home page's drawing of the app (rules 3348-3352): a plain sketch of Thakeen's own screen (the side menu, the
 * approvals waiting, the week's tasks, the agents) and a preview of the three team roles. Ideas from the Supastarter
 * marketing hero, without its figures: CLAUDE.md forbids invented customers, numbers and results, so the drawing holds no
 * digit, no count, no money and no result, only the names of real features, grey bars where text would be, and an empty
 * state. The role previews use drawn avatars (no photographs) and read each permission from MIN_ROLE in src/lib/roles.ts.
 *
 * Where it goes (rule 3348): the cover already holds the masthead, the team lineup and the signup form, so the drawing
 * does not go inside it. `APP_SCREEN_SPOT` puts it in its own section: after the live UI gallery (the default), right
 * under the cover, or nowhere.
 */
export type AppScreenSpot = "after-gallery" | "after-cover" | "off";
export const APP_SCREEN_SPOT: AppScreenSpot = "after-gallery";

type L = { ar: string; en: string };

export const APP_SCREEN_COPY = {
  h: { ar: "مساحة عملك من الداخل", en: "Inside your workspace" },
  sub: {
    ar: "رسم مبسّط لشاشة ذكين: وكلاؤك، ومهام الأسبوع، وما ينتظر موافقتك.",
    en: "A simple sketch of the Thakeen screen: your agents, the week's tasks, and what waits for your approval.",
  },
  note: { ar: "رسم توضيحي، بلا بيانات حقيقية.", en: "An illustration, with no real data." },
  alt: {
    ar: "رسم لشاشة ذكين: قائمة جانبية فيها المهام والموافقات والوكلاء والمحادثة والتقارير، ولوحة فيها مسودات تنتظر الموافقة ومهام الأسبوع ووكلاء الفريق.",
    en: "A sketch of the Thakeen screen: a side menu with tasks, approvals, agents, chat and reports, and a board with drafts waiting for approval, the week's tasks and the team's agents.",
  },
  nav: [
    { ar: "المهام", en: "Tasks" },
    { ar: "الموافقات", en: "Approvals" },
    { ar: "الوكلاء", en: "Agents" },
    { ar: "المحادثة", en: "Chat" },
    { ar: "التقارير", en: "Reports" },
    { ar: "ملف العلامة", en: "Brand file" },
  ] as L[],
  approvals: { ar: "بانتظار موافقتك", en: "Waiting for your approval" },
  approve: { ar: "اعتماد", en: "Approve" },
  edit: { ar: "تعديل", en: "Edit" },
  tasks: { ar: "مهام الأسبوع", en: "This week's tasks" },
  states: [
    { ar: "مسودة", en: "Draft" },
    { ar: "قيد المراجعة", en: "In review" },
    { ar: "معتمدة", en: "Approved" },
  ] as L[],
  agents: { ar: "فريق الوكلاء", en: "Your agents" },
  empty: { ar: "لا شيء هنا بعد", en: "Nothing here yet" },
  reports: { ar: "التقارير", en: "Reports" },
} as const;

/** Words that read as a business result or a client count: the drawing never shows them (rule 3350). */
export const RESULT_WORDS = /revenue|growth|churn|\bROI\b|client|customer|testimonial|إيراد|نمو|عميل|عملاء|أرباح/i;

/**
 * The agents the sketch shows: the first four of the real lineup (src/lib/agents.ts) whose role names no result, by name
 * and role, with their own colour token. Picked from the registry, never a list of ids of its own (rule 202).
 */
export const SCREEN_AGENTS = AGENTS.filter((a) => !RESULT_WORDS.test(a.role.ar) && !RESULT_WORDS.test(a.role.en))
  .slice(0, 4)
  .map((a) => ({ id: a.id, name: a.name, role: a.role }));

export type RoleId = "owner" | "admin" | "member";

/** The rows each role card lists: a real action from MIN_ROLE and how the site says it. */
export const ROLE_ROWS: { action: Action; label: L }[] = [
  { action: "billing", label: { ar: "الاشتراك والفواتير", en: "Plan and billing" } },
  { action: "team.role", label: { ar: "تغيير أدوار الفريق", en: "Change team roles" } },
  { action: "publish", label: { ar: "اعتماد المحتوى ونشره", en: "Approve and publish" } },
  { action: "brand.write", label: { ar: "تعديل ملف العلامة", en: "Edit the brand file" } },
  { action: "connectors", label: { ar: "ربط الحسابات", en: "Connect accounts" } },
  { action: "team.invite.member", label: { ar: "دعوة عضو", en: "Invite a member" } },
  { action: "generate", label: { ar: "طلب محتوى من الوكلاء", en: "Ask agents for content" } },
  { action: "drafts", label: { ar: "تعديل المسودات", en: "Edit drafts" } },
];

/** The three roles, named as the app's team page names them (src/lib/app-i18n-team.ts), with one plain line each. */
export const ROLE_PREVIEW: { id: RoleId; name: L; line: L }[] = [
  { id: "owner", name: { ar: "المالك", en: "Owner" }, line: { ar: "صاحب الحساب: الاشتراك والفريق وكل الصلاحيات.", en: "Holds the account: the plan, the team and every permission." } },
  { id: "admin", name: { ar: "مدير", en: "Admin" }, line: { ar: "يدير العمل اليومي: يعتمد وينشر ويضبط العلامة والربط.", en: "Runs the daily work: approves, publishes, sets up the brand and connections." } },
  { id: "member", name: { ar: "عضو", en: "Member" }, line: { ar: "يعمل مع الوكلاء: يطلب المحتوى ويعدّل المسودات.", en: "Works with the agents: asks for content and edits drafts." } },
];

export const ROLES_COPY = {
  h: { ar: "لكل شخص في فريقك دوره", en: "Everyone on your team has a role" },
  sub: {
    ar: "ثلاثة أدوار، وصلاحيات كل بطاقة هنا مأخوذة من جدول صلاحيات ذكين نفسه.",
    en: "Three roles. Each card reads its permissions from Thakeen's own permission table.",
  },
  can: { ar: "مسموح", en: "Allowed" },
  cannot: { ar: "غير مسموح", en: "Not allowed" },
} as const;

/** The role cards' rows for one role: every row, with whether that role reaches it in MIN_ROLE. */
export const roleRows = (role: RoleId, lang: Lang): { label: string; allowed: boolean }[] =>
  ROLE_ROWS.map((r) => ({ label: r.label[lang], allowed: roleMeets(role, r.action) }));

/** Every visible string the drawing and the role cards own, both languages (rule 3350's scan). */
export function appScreenStrings(): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === "object") Object.values(v).forEach(add);
  };
  add(APP_SCREEN_COPY);
  add(ROLES_COPY);
  add(ROLE_ROWS.map((r) => r.label));
  add(ROLE_PREVIEW.map((r) => [r.name, r.line]));
  add(SCREEN_AGENTS.map((a) => [a.name, a.role]));
  return out;
}
