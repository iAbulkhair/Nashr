import { isProductionDeploy } from "./deploy-env";
import { errorTag } from "./log-safe";
import { requestId } from "./request-id";

export { REQUEST_ID_HEADER, REQUEST_ID_SHAPE, requestId } from "./request-id";

/**
 * The one logger (rules 1970-1974). A thin layer over `console` with four levels, so a line in the host's log says how
 * bad it is and carries only fields that are safe to keep. Server code writes `log.error("email refused", { from })`
 * instead of `console.error(...)`.
 *
 * What it never writes (CLAUDE.md, "secrets are never logged"):
 * - the value of any field whose name says it holds a secret (`key`, `token`, `secret`, `password`, `authorization`,
 *   `cookie`, `code`, `otp`, `signature`), at any depth: it becomes "[redacted]";
 * - a caught error's message, stack or body: an `Error` value becomes its `errorTag` (class name and HTTP status, rule
 *   1354), because a provider's error body can echo what was sent to it;
 * - a string that looks like a credential wherever it sits (`Bearer …`, `sk-…`/`re_…`/`whsec_…` style keys, a JWT, a
 *   long unbroken hex or base64 run): it becomes "[redacted]";
 * - more than `MAX_STRING` characters of any one string.
 *
 * `debug` lines are dropped on a production deploy. Without fields a line is the message alone, exactly what the old
 * `console.*(message)` call wrote, so existing log searches keep matching.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

/** Field names whose values are never written. Matched anywhere in the name, case-insensitive (`apiKey`, `x-auth-token`). */
export const SECRET_FIELD = /key|token|secret|passw|authoriz|cookie|^code$|otp|signature|credential|bearer/i;
/** Values that look like a credential whatever field holds them. */
const SECRET_VALUE = [
  /\bbearer\s+\S+/i,
  /\b(?:sk|pk|rk|re|whsec|xox[abpr]|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b[a-f0-9]{40,}\b/i,
  // No slash in the run: a long path such as `/ar/app/settings/…` is not a key.
  /[A-Za-z0-9+_-]{48,}={0,2}/,
];
/** A string holding something that looks like a credential (the patterns above); memory refuses to keep one (rule 4551). */
export const looksLikeCredential = (s: string): boolean => SECRET_VALUE.some((re) => re.test(s));
export const MAX_STRING = 300;
const MAX_DEPTH = 4;
const MAX_KEYS = 30;
const REDACTED = "[redacted]";

/** One value as it may be logged (see the note at the top). Exported for the tests. */
export function scrub(v: unknown, depth = 0): unknown {
  if (v instanceof Error) return errorTag(v);
  if (typeof v === "string") {
    if (looksLikeCredential(v)) return REDACTED;
    return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  }
  if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return typeof v;
  if (depth >= MAX_DEPTH) return "[object]";
  if (Array.isArray(v)) return v.slice(0, MAX_KEYS).map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_KEYS)) out[k] = SECRET_FIELD.test(k) ? REDACTED : scrub(x, depth + 1);
  return out;
}


function write(level: LogLevel, message: string, fields?: LogFields | unknown): void {
  if (level === "debug" && isProductionDeploy()) return;
  const msg = scrub(String(message)) as string;
  // A bare caught value (`log.error("x failed", e)`) is accepted and tagged like a field would be.
  if (fields === undefined) console[level](msg);
  else if (fields instanceof Error || typeof fields !== "object" || fields === null) console[level](msg, { error: scrub(fields) });
  else console[level](msg, scrub(fields));
}

export const log = {
  debug: (message: string, fields?: LogFields | unknown) => write("debug", message, fields),
  info: (message: string, fields?: LogFields | unknown) => write("info", message, fields),
  warn: (message: string, fields?: LogFields | unknown) => write("warn", message, fields),
  error: (message: string, fields?: LogFields | unknown) => write("error", message, fields),
  /** A logger whose every line also carries these fields, such as the request id (`withRequest`). */
  with(base: LogFields) {
    const merge = (f?: LogFields | unknown): LogFields => (f && typeof f === "object" && !(f instanceof Error) ? { ...base, ...(f as LogFields) } : f === undefined ? base : { ...base, error: f });
    return {
      debug: (m: string, f?: LogFields | unknown) => write("debug", m, merge(f)),
      info: (m: string, f?: LogFields | unknown) => write("info", m, merge(f)),
      warn: (m: string, f?: LogFields | unknown) => write("warn", m, merge(f)),
      error: (m: string, f?: LogFields | unknown) => write("error", m, merge(f)),
    };
  },
};

/** A logger for one request: every line carries `rid`, the id the proxy gave it, so its lines can be found together. */
export function withRequest(req: { headers: Pick<Headers, "get"> }) {
  const rid = requestId(req.headers);
  return rid ? log.with({ rid }) : log;
}
