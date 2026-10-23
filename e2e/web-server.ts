import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { globalKey, runClaim } from "../src/lib/keys";

/**
 * The end-to-end server's start command (rule 1207). CI's Build step has already run `npm run build:hostinger` (rule
 * 1017) by the time the suite starts, so under `CI` with that build present (`.next/BUILD_ID`) the server only runs
 * `next start`: building a second time cost CI about 45 seconds on every end-to-end run. Anywhere else, a developer's
 * machine included, the command builds first, so a local run never tests a stale `.next`.
 *
 * `APP_ENV=test` is a runtime setting (the web server's `env`): the memory store, the model mock and `devCode` read it
 * at call time, and the only build-time readers (`robots.ts`, `sitemap.ts`) ask `isStaging()`, which is false both
 * unset and under `test`. So CI's build, made without `APP_ENV` like thakeen.com's, serves the suite unchanged.
 */
export function webServerCommand(port: number, opts: { ci: boolean; prebuilt: boolean }): string {
  const start = `npx next start -p ${port}`;
  return opts.ci && opts.prebuilt ? start : `npm run build:hostinger && ${start}`;
}

/**
 * Is there a production build in `dir`? `next build` writes `.next/BUILD_ID`. In CI the checkout is fresh and the Next
 * cache restores only `.next/cache`, so the file exists only when this run's Build step built; a failed build stops the job.
 */
export const hasBuild = (dir = process.cwd()): boolean => existsSync(join(dir, ".next", "BUILD_ID"));

/**
 * The console key the end-to-end server starts with (`WAITLIST_ADMIN_KEY`): the passkey spec flips the passkey off switch,
 * which only a console actor may (rule 2426), through the `x-admin-key` header. Random per run, made once in the runner
 * when it loads this config and inherited by its workers through the environment, so no key is written in the repository
 * and a server from another run never accepts it.
 */
export const E2E_ADMIN_KEY = (process.env.E2E_ADMIN_KEY ??= randomBytes(24).toString("base64url"));

/**
 * Rule 3008: the encryption secret of the end-to-end server, made the same way (fresh per run, inherited by the workers,
 * never written down). A production build refuses to fall back when `CONNECT_SECRET` is unset (`connectSecret`), so
 * enrolling two-step sign-in, which seals the authenticator secret with it, answered 500 without one.
 */
export const E2E_CONNECT_SECRET = (process.env.E2E_CONNECT_SECRET ??= randomBytes(32).toString("base64url"));

/**
 * Rule 2590: what the end-to-end server's memory store starts with (`E2E_SEED_KV`, read by `seedForE2e` in src/lib/db.ts),
 * for the two screens no request can stage: this month's Razan routine held for the seeded owner after a kill (rule 2479),
 * and a daily cron report beside its heartbeat (rules 2484-2485). Keys come from the app's own builders. The owner's account
 * id is its address (`OPAQUE_IDS` is off) and its default brand's scope is that id.
 */
export function e2eSeed(owner: string, now = new Date()): string {
  const at = now.toISOString();
  return JSON.stringify({
    [globalKey.runReceipt(runClaim.routine(owner, HELD_ROUTINE, at.slice(0, 7)))]: { state: "held", at },
    [globalKey.cronReport("daily")]: { at, period: at.slice(0, 10), chain: 1, ...E2E_CRON_REPORT },
    "cronbeat:daily": now.getTime(),
    // The reset links no mailbox can deliver here (no mail is configured on the test server): the password-reset spec signs the
    // address up and then opens the link, as the mail would have. The record is the one ../src/app/api/auth/forgot writes.
    ...Object.fromEntries(Object.values(E2E_RESET).map((r) => [`pwreset:${createHash("sha256").update(r.token).digest("hex")}`, { email: r.email, kind: "owner" }])),
  });
}
/**
 * Password-reset tokens the seed holds, each for an address and a purpose of its own (a token works once). `api` and `ui` are
 * for addresses the spec signs up first; `ghost` is for an address that never signs up, so its link must be refused.
 */
export const E2E_RESET = {
  api: { email: "e2e-reset-api@test.example", token: "5a".repeat(32) },
  ui: { email: "e2e-reset-ui@test.example", token: "6b".repeat(32) },
  ghost: { email: "e2e-reset-ghost@test.example", token: "7c".repeat(32) },
} as const;
/** The monthly routine the seed holds, and the counts the seeded report shows. */
export const HELD_ROUTINE = "razan_cash_forecast";
export const E2E_CRON_REPORT = { total: 40, alreadyDone: 5, processed: 30, failed: 2, held: 1, remaining: 2 } as const;
