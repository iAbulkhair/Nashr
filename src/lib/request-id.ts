/**
 * The request id (rule 1975). Import-free on purpose: the proxy loads it, and nothing the proxy loads may reach the
 * store (tests/staging.test.ts holds that list closed). src/lib/log.ts re-exports it for route code.
 */

/** The header the proxy sets on every request it passes on and on every response (src/proxy.ts). */
export const REQUEST_ID_HEADER = "x-request-id";
/** A request id the proxy may keep from an upstream hop: short, letters, digits and dashes only. Anything else is replaced. */
export const REQUEST_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

/** The request's id when it carries a well-formed one, else null. */
export function requestId(headers: Pick<Headers, "get">): string | null {
  const v = headers.get(REQUEST_ID_HEADER);
  return v && REQUEST_ID_SHAPE.test(v) ? v : null;
}
