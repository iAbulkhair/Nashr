/**
 * The classifier's answer words (rule 791; spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md section 6).
 * A leaf on purpose: it imports nothing, so agent-scope.ts (the decision) and agent-scope-classify.ts (the model call) both
 * read the words from here and neither imports the other's module while it loads. A test mocks one of them with
 * `vi.mock(..., async (orig) => ...)`, which loads the real module, and two modules that wait on each other would hang it.
 * agent-scope.ts re-exports these, so `import { VERDICTS } from "./agent-scope"` keeps working.
 */

/** The classifier's answer. `in` is work the team does; the rest are refused in enforce mode. */
export const VERDICTS = ["in", "off_topic", "pro_advice", "other_business", "personal", "other_brand"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const isVerdict = (x: unknown): x is Verdict => typeof x === "string" && (VERDICTS as readonly string[]).includes(x);
