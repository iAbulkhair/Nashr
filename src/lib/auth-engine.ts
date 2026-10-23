/**
 * The sign-in engine switch (docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md, rules 3400, 3401).
 *
 * `AUTH_ENGINE=better-auth` turns on better-auth's endpoints (`/api/better-auth/*`), the magic link, the oRPC endpoint
 * (`/api/rpc/*`) and the log-in form's tab switch. It is read at CALL time, never at build time, so one build serves both
 * engines and a rollback is one variable. It also needs `BETTER_AUTH_SECRET`, at least 32 characters: better-auth signs
 * the cookie it reads internally with it. Any other value of `AUTH_ENGINE`, or a missing or short secret, is the legacy
 * engine, and nothing that names a value is logged.
 *
 * Imports nothing, so every module (routes, the proxy, pages) can read the switch without a cycle.
 */
export type AuthEngine = "better-auth" | "legacy";

/** The shortest secret better-auth may sign with. better-auth itself refuses shorter ones only in production. */
export const BA_SECRET_MIN = 32;

/** The secret better-auth signs its internal cookie with, or null when it is missing or shorter than `BA_SECRET_MIN`. */
export function baSecret(): string | null {
  const s = process.env.BETTER_AUTH_SECRET ?? "";
  return s.length >= BA_SECRET_MIN ? s : null;
}

/** The engine for this call: better-auth only when the switch says so AND the secret is usable (fails closed to legacy). */
export function authEngine(): AuthEngine {
  return (process.env.AUTH_ENGINE ?? "").trim() === "better-auth" && baSecret() !== null ? "better-auth" : "legacy";
}

/** True while the better-auth engine is on (rule 3400). */
export const baOn = (): boolean => authEngine() === "better-auth";
