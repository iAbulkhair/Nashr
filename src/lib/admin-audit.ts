import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { parseReason } from "./admin-input";
import { CAPS, pushCapped } from "./db";
import { AUDIT_SECTIONS, type AuditSection } from "./admin-audit-shape";

/**
 * The founder audit log, `admin:log` (rules 1172-1175, Control Center spec rules 1069, 1071 and 1072): `adminAudit` is its only
 * writer. Every row names who acted (`actor`: the founder's email, `"key"` for the console key, or a system writer such
 * as `"paymob"` or `"system"`), when (`at`), what (`action`, plus the legacy free-text `what`), on what (`target`, and
 * the legacy `email`), the state before and after when the caller has it, and the founder's reason.
 *
 * Stored shape, an expand (rule 679): `id`, `section`, `action`, `target` and `imp` are new and optional for a reader;
 * `what`, `email`, `actor`, `before`, `after`, `reason` and `at` keep their old names and meaning, so every old reader
 * and every row written before this change still read. The Log page shows an old row as "legacy" (no `id`). Contract
 * step (a later release): readers may require `section` and `action` once every row older than the cap is gone; with
 * 5,000 rows that is whenever the founder has done 5,000 more things, so the contract waits for the founder's call.
 *
 * Secrets never reach a row (rule 1173): keys that name a secret are dropped wherever they sit (`password`, `passHash`,
 * `token`, `secret`, `cookie`, `session`, `hmac`, `apiKey`, a card or a payment reference), and the value of every
 * secret-named environment variable is masked wherever it appears. A reason is one line of at most 200 characters.
 */

// The section names live in the client-safe half, which the Log page reads (rule 1179).
export { AUDIT_SECTIONS, type AuditSection };

export type AuditRow = {
  /** 12 hex characters; rows written before 2026-10-11 have none (legacy). */
  id?: string;
  at: string;
  actor: string;
  /** Set when the founder acted from inside an impersonated account. */
  imp?: string;
  /**
   * How the actor reached the console (rule 1638): a staff session, the key session, the `x-admin-key` header, or the
   * founder's customer session (expand only, rule 1649). Optional and new (rule 679): old rows have none, old readers
   * ignore it.
   */
  via?: AuditVia;
  section?: AuditSection;
  action?: string;
  target?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  /** Legacy: the target account (or a pseudo target such as "wishlist", "golden-set", "mail"). */
  email?: string;
  /** Legacy: the free-text summary every reader before 2026-10-11 shows. */
  what: string;
  [extra: string]: unknown;
};

/** How an actor reached the console (rule 1638). */
export type AuditVia = "staff" | "key" | "header" | "founder-session";
export const AUDIT_VIAS: readonly AuditVia[] = ["staff", "key", "header", "founder-session"];

export type AuditInput = {
  actor: string;
  /** How the actor reached the console; `viaOf(req)` in src/lib/auth.ts answers it for a console request. */
  via?: AuditVia | null;
  section: AuditSection;
  /** The legacy one-line summary. */
  what: string;
  /** A short machine name; defaults to the first word of `what` ("topup_void", "partner", "impersonate"). */
  action?: string;
  /** The account, partner or item acted on; also written as the legacy `email`. */
  target?: string;
  before?: unknown;
  after?: unknown;
  reason?: unknown;
  imp?: string;
  /** Extra structured fields old rows already carried (`team`, `topup`, `refund`). Redacted like the rest. */
  extra?: Record<string, unknown>;
};

/** Cap on `admin:log` (was 2,000 until 2026-10-11, rule 1174). */
export const AUDIT_CAP = CAPS.adminLog;
export const REASON_MAX = 200;
/** A key that names a secret. Matched on the whole key, case-insensitive, anywhere in a row. */
const SECRET_KEY = /^(pass(word)?|passhash|temppassword|newpassword|currentpassword|token|tokens|secret|secrets|apikey|api_key|key|cookie|cookies|session|sessions|hmac|authorization|card(token)?|cardtoken|ref|paymentref|kp)$/i;
/** Environment variables whose value is a secret: masked wherever it appears in a row. */
const SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|HMAC|PRIVATE)/;
const MASK = "[redacted]";

/** One line, at most 200 characters, or undefined. */
export function cleanReason(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\r\n\t]+/g, " ").trim().slice(0, REASON_MAX);
  return s || undefined;
}

function secretValues(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) if (SECRET_ENV.test(k) && typeof v === "string" && v.length >= 8) out.push(v);
  // Longest first, so a secret that contains another is masked whole.
  return out.sort((a, b) => b.length - a.length);
}

/** Deep copy without secret-named keys. Depth-capped: a row is a summary, never a dump. */
export function redact(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return MASK;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = redact(x, depth + 1);
  }
  return out;
}

/** The fields `adminAudit` sets itself: an `extra` field of the same name is dropped, never spread over them (rule 1184). */
const RESERVED = new Set(["id", "at", "actor", "imp", "via", "section", "action", "target", "email", "what", "before", "after", "reason", "legacy"]);

/** `extra` without the reserved names, redacted like the rest of the row. */
function extraOf(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return {};
  const out = redact(extra) as Record<string, unknown>;
  for (const k of Object.keys(out)) if (RESERVED.has(k)) delete out[k];
  return out;
}

/** The row `adminAudit` writes, without writing it (tests and the planted-secret check use it). */
export function auditRow(i: AuditInput, now = new Date()): AuditRow {
  const action = (i.action ?? i.what.split(/[\s:]/)[0] ?? "").slice(0, 60) || "unknown";
  const row: AuditRow = {
    // Extra first, and without the reserved names, so it can never stand in for who, when or what (rule 1184).
    ...extraOf(i.extra),
    id: randomBytes(6).toString("hex"),
    at: now.toISOString(),
    actor: String(i.actor).slice(0, 200),
    ...(i.imp ? { imp: i.imp } : {}),
    ...(i.via && AUDIT_VIAS.includes(i.via) ? { via: i.via } : {}),
    section: i.section,
    action,
    ...(i.target ? { target: i.target, email: i.target } : {}),
    what: i.what.slice(0, 1000),
    ...(i.before !== undefined ? { before: redact(i.before) } : {}),
    ...(i.after !== undefined ? { after: redact(i.after) } : {}),
  };
  const reason = cleanReason(i.reason);
  if (reason) row.reason = reason;
  return row;
}

/**
 * Text that looks like a secret whatever its name (rule 1189): an `sk-` key, a `Bearer` token, a run of 32 or more hex
 * digits (a session token, a hash), and a run of 40 or more base64 or base64url characters holding a letter and a digit.
 * A key name or an environment value catches most secrets; these catch one pasted into a reason or a free-text summary.
 * Emails, dates, ids such as `rf_` plus 18 hex digits and ordinary words are shorter or broken by other characters.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b[a-f0-9]{32,}\b/gi,
  /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

/** Mask every secret environment value, and every secret-shaped run of text, inside a serialised row. */
export function maskSecrets(json: string): string {
  let s = json;
  for (const v of secretValues()) {
    const enc = JSON.stringify(v).slice(1, -1);
    if (enc && s.includes(enc)) s = s.split(enc).join(MASK);
  }
  for (const re of SECRET_SHAPES) s = s.replace(re, MASK);
  return s;
}

/**
 * The server's check on a founder change's reason (rule 1185, Control Center spec rule 1070): 3 to 200 characters after
 * trimming, the same `parseReason` the console runs. A 400 `reason_short` or `reason_long` when it fails, else null.
 * Every founder caller goes through it, the console key included: the key is an admin caller like the cookie.
 */
export function reasonRefused(raw: unknown): NextResponse | null {
  const r = parseReason(typeof raw === "string" ? raw : null);
  return r.ok ? null : NextResponse.json({ ok: false, error: r.error }, { status: 400 });
}

/** Write one audit row to `admin:log` (newest first, capped at `AUDIT_CAP`). The only writer of that list. */
export async function adminAudit(i: AuditInput): Promise<AuditRow> {
  const row = auditRow(i);
  const json = maskSecrets(JSON.stringify(row));
  await pushCapped("admin:log", json, AUDIT_CAP);
  return JSON.parse(json) as AuditRow;
}

/** What the Log page filters on (rule 1175). Every field is optional; text matches ignore case. */
export type AuditFilter = { section?: string; actor?: string; action?: string; target?: string };
export const AUDIT_PAGE = 50;
export type AuditView = AuditRow & { legacy: boolean; action: string };

/** A row's action and target, read from an old row's legacy fields when the new ones are missing. */
export function auditView(r: AuditRow): AuditView {
  return {
    ...r,
    legacy: !r.id,
    action: r.action ?? (typeof r.what === "string" ? r.what.split(/[\s:]/)[0] : ""),
    target: r.target ?? r.email,
  };
}

const has = (v: unknown, q: string) => typeof v === "string" && v.toLowerCase().includes(q);

/** True when the row passes every filter given. An old row has no section, so a section filter leaves it out. */
export function auditMatches(r: AuditRow, f: AuditFilter): boolean {
  const v = auditView(r);
  if (f.section && v.section !== f.section) return false;
  if (f.actor && !has(v.actor, f.actor.toLowerCase())) return false;
  if (f.action && !has(v.action, f.action.toLowerCase()) && !has(v.what, f.action.toLowerCase())) return false;
  if (f.target && !has(v.target, f.target.toLowerCase())) return false;
  return true;
}

/** A filter read from a query string: known sections only, every text cut to 120 characters. */
export function parseAuditFilter(q: URLSearchParams): AuditFilter {
  const f: AuditFilter = {};
  const section = q.get("section") ?? "";
  if ((AUDIT_SECTIONS as readonly string[]).includes(section)) f.section = section;
  for (const k of ["actor", "action", "target"] as const) {
    const v = (q.get(k) ?? "").trim().slice(0, 120);
    if (v) f[k] = v;
  }
  return f;
}

/**
 * One page of rows that pass `f`, newest first, from the position `from` in the list (0 = newest). `next` is where the
 * following page starts, or null when the list has no more. Rows that are not JSON are skipped.
 */
export function pageAudit(raw: string[], f: AuditFilter, from: number, per = AUDIT_PAGE): { rows: AuditView[]; next: number | null } {
  const rows: AuditView[] = [];
  let i = Math.max(0, Math.trunc(from) || 0);
  for (; i < raw.length && rows.length < per; i++) {
    let r: AuditRow;
    try { r = JSON.parse(raw[i]) as AuditRow; } catch { continue; }
    if (!r || typeof r !== "object") continue;
    if (auditMatches(r, f)) rows.push(auditView(r));
  }
  return { rows, next: i < raw.length ? i : null };
}
