import bcrypt from "bcryptjs";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { SESSION_TTL } from "@/lib/auth";
import { baSecret } from "@/lib/auth-engine";
import { appOrigin } from "@/lib/origin";
import { redisAdapter } from "./adapter";
import { sessionCreated, sessionGate } from "./gate";
import { baMagicLink } from "./magic";

/**
 * The one better-auth configuration (docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md, rules 3410-3414).
 * Built lazily, only while `AUTH_ENGINE=better-auth` (src/lib/auth-engine.ts); with the switch off nothing here runs and
 * the route answers 404 before reaching it.
 *
 * - The store is the Redis projection adapter (src/lib/better-auth/adapter.ts): no copy of any user, password or link.
 * - Sign-up, refresh, cookie cache, better-auth's limiter, telemetry, linking, e-mail change and deletion are off.
 *   Thakeen's routes keep doing those; the route wrapper's allow-list (rule 3413) is the second wall.
 * - Passwords are the bcrypt hashes Thakeen stores; better-auth only compares (sign-up is off, so it never hashes one
 *   except the dummy hash it runs for an unknown address, which keeps the timing even).
 * - Every session goes through the gate (rule 3411) and is written by `issueSession` (rule 3407).
 * - better-auth's own cookies (prefix `thakeen.`) never reach a browser: the wrapper builds the one it reads from
 *   `thakeen_session` and drops every one it sets (rule 3410). `useSecureCookies: false` keeps that name fixed
 *   (`thakeen.session_token`) on every host; the browser cookie keeps the attributes `createSession` gives it.
 */
export const BA_BASE_PATH = "/api/better-auth";
export const BA_COOKIE_PREFIX = "thakeen";
/** better-auth's internal session cookie name, as `getCookies` builds it from the options below. */
export const BA_SESSION_COOKIE = `${BA_COOKIE_PREFIX}.session_token`;
/** better-auth's Google provider (rule 3425) stays off until its redirect URI is registered in the Google console. */
export const BA_GOOGLE = false;
/** The longest password better-auth compares; longer bodies are refused before bcrypt runs. */
export const BA_PASSWORD_MAX = 1024;

export function baOptions(secret: string) {
  const origin = appOrigin();
  return {
    appName: "Thakeen",
    basePath: BA_BASE_PATH,
    baseURL: origin,
    // `secrets` wins over every environment variable better-auth would read (`BETTER_AUTH_SECRETS`), so the cookie the
    // wrapper signs and the one better-auth checks always use this one secret.
    secrets: [{ version: 1, value: secret }],
    trustedOrigins: [origin],
    database: redisAdapter(),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      maxPasswordLength: BA_PASSWORD_MAX,
      password: {
        hash: (password: string) => bcrypt.hash(password, 10),
        verify: async ({ hash, password }: { hash: string; password: string }) => {
          try {
            return await bcrypt.compare(password, hash);
          } catch {
            return false;
          }
        },
      },
    },
    session: { expiresIn: SESSION_TTL, disableSessionRefresh: true, cookieCache: { enabled: false } },
    verification: { disableCleanup: true },
    account: { accountLinking: { enabled: false } },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    advanced: { cookiePrefix: BA_COOKIE_PREFIX, useSecureCookies: false },
    databaseHooks: { session: { create: { before: sessionGate, after: sessionCreated } } },
    // The magic link (rules 3415-3416, ./magic.ts). The only plugin: an upgrade's new endpoints stay unreachable (rule 3413).
    plugins: [baMagicLink()],
  } satisfies BetterAuthOptions;
}

const make = (secret: string) => betterAuth(baOptions(secret));
type Auth = ReturnType<typeof make>;
const g = globalThis as unknown as { __thakeenBa?: { key: string; auth: Auth } };

/** The better-auth instance for the current secret and origin, or null while the engine is off. */
export function getAuth(): Auth | null {
  const secret = baSecret();
  if (!secret) return null;
  const key = `${appOrigin()}\n${secret}`;
  if (g.__thakeenBa?.key !== key) g.__thakeenBa = { key, auth: make(secret) };
  return g.__thakeenBa.auth;
}
