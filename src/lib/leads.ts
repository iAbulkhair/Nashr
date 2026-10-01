import { db } from "./db";
import { csvSafe } from "./admin-stats";

/**
 * The founder console's Leads tab (#134): enterprise and early-adopter requests (support tickets from ContactForm), the
 * affiliate applications and, on request, every other support ticket, newest first.
 *
 * Both lists are capped (`CAPS.tickets`) and pushed to the head, so the newest `LEADS_SCAN` of each are read in one round
 * trip and merged by date. Email may not reach the founder (no verified sender yet), so this view is where a lead is
 * certain to be seen; `admin:leads:seen` holds when the founder last opened it, for the unread count on the tab.
 *
 * Every field shown is visitor-typed text: the console renders it as text (React escapes it), never as HTML, and the CSV
 * export puts every cell through `csvSafe`. Nothing here is logged.
 */
export const LEADS_SCAN = 500;
export const LEADS_PAGE_MAX = 100;
export const LEADS_SEEN_KEY = "admin:leads:seen";

export type LeadKind = "enterprise" | "early-adopter" | "affiliate" | "support";
/** Sales leads are what the tab shows by default and what the unread count counts; "support" is every other ticket. */
export const SALES_KINDS: readonly LeadKind[] = ["enterprise", "early-adopter", "affiliate"];

export type Lead = {
  kind: LeadKind;
  /** The ticket's own type when it is a support ticket (`question`, `bug`, …), else the kind. */
  type: string;
  at: string;
  name: string;
  company: string;
  message: string;
  email: string;
  phone: string;
  page: string;
  lang: "ar" | "en";
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const parse = (raw: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * ContactForm sends "Name: …\nCompany: …\n\n<message>" as one message (src/components/ContactForm.tsx). The two header
 * lines are lifted out so the console can show who wrote it; a message without them is shown whole.
 */
export function splitContact(message: string): { name: string; company: string; body: string } {
  const m = /^Name: ?(.*)\nCompany: ?(.*)\n\n?([\s\S]*)$/.exec(message);
  return m ? { name: m[1].trim(), company: m[2].trim(), body: m[3] } : { name: "", company: "", body: message };
}

export function ticketLead(raw: string): Lead | null {
  const r = parse(raw);
  if (!r) return null;
  const type = str(r.type, 20) || "question";
  const kind: LeadKind = type === "enterprise" || type === "early-adopter" ? type : "support";
  const { name, company, body } = splitContact(str(r.message, 4000));
  return { kind, type, at: str(r.at, 40), name, company, message: body, email: str(r.email, 120), phone: "", page: str(r.page, 200), lang: r.lang === "en" ? "en" : "ar" };
}

export function affiliateLead(raw: string): Lead | null {
  const r = parse(raw);
  if (!r) return null;
  const channel = str(r.channel, 200), audience = str(r.audience, 100);
  return { kind: "affiliate", type: "affiliate", at: str(r.at, 40), name: str(r.name, 80), company: "", message: [channel, audience].filter(Boolean).join(" · "), email: str(r.email, 120), phone: str(r.phone, 30), page: "/affiliates", lang: r.lang === "en" ? "en" : "ar" };
}

export type LeadsPage = { leads: Lead[]; total: number; unread: number; seenAt: string | null; scanned: { tickets: number; affiliates: number } };

/**
 * Leads newest first. `all` adds every other support ticket to the sales leads. `limit` is clamped to `LEADS_PAGE_MAX`
 * for the console; `everything` returns every row read (the CSV export, bounded by `LEADS_SCAN` per list).
 */
export async function listLeads(opts: { all?: boolean; offset?: number; limit?: number; everything?: boolean } = {}): Promise<LeadsPage> {
  const offset = opts.everything ? 0 : Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = opts.everything ? Infinity : Math.min(LEADS_PAGE_MAX, Math.max(0, Math.floor(opts.limit ?? 50)));
  const [tickets, affiliates, seenAt] = await Promise.all([
    db.lrange("support-tickets", 0, LEADS_SCAN - 1),
    db.lrange("affiliate-applications", 0, LEADS_SCAN - 1),
    db.get<string>(LEADS_SEEN_KEY),
  ]);
  const every = [...tickets.map(ticketLead), ...affiliates.map(affiliateLead)].filter((l): l is Lead => l !== null);
  const shown = every.filter((l) => opts.all || SALES_KINDS.includes(l.kind)).sort((a, b) => b.at.localeCompare(a.at));
  const seen = typeof seenAt === "string" ? seenAt : null;
  const unread = every.filter((l) => SALES_KINDS.includes(l.kind) && (!seen || l.at > seen)).length;
  return { leads: shown.slice(offset, offset + limit), total: shown.length, unread, seenAt: seen, scanned: { tickets: tickets.length, affiliates: affiliates.length } };
}

/** The founder opened the tab: everything up to now is read. */
export async function markLeadsSeen(now = new Date()): Promise<string> {
  const at = now.toISOString();
  await db.set(LEADS_SEEN_KEY, at);
  return at;
}

/** UTF-8 CSV (the route adds the BOM). Every cell through `csvSafe`: a visitor's "=HYPERLINK(…)" must stay text in Excel. */
export function leadsCsv(leads: Lead[]): string {
  const esc = (v: unknown) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
  const cols: (keyof Lead)[] = ["at", "kind", "type", "name", "company", "email", "phone", "message", "page", "lang"];
  return [cols.join(","), ...leads.map((l) => cols.map((c) => esc(l[c])).join(","))].join("\r\n");
}
