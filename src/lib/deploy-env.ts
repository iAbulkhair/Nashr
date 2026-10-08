/**
 * Is this process serving customers? The production guards (rule 430: never the memory store; rule 431: never the model
 * mock) ask this one question, on any host: Vercel, Hostinger or anything else.
 *
 * Fail closed. Any production build (`next build` + `next start`, where Next fixes `NODE_ENV` to "production") counts as
 * production unless the host says otherwise, so wiping a host's environment variables makes the site refuse loudly
 * instead of saving to memory and answering with [DEV MOCK] content. In order:
 *   1. `VERCEL_ENV=production` or `APP_ENV=production`: production. Nothing overrides these.
 *   2. `APP_ENV` set to `test`, `development` or `preview`: not production. The e2e suite sets `APP_ENV=test` (it runs a
 *      production build with no Redis and no model key). Any other `APP_ENV` value, a typo included, is production.
 *   3. `VERCEL_ENV` `preview` or `development`: not production (Vercel previews keep their old behaviour).
 *   4. Otherwise `NODE_ENV === "production"`. `next dev` is "development", vitest is "test".
 * Rules 430-431, tests/launch-security.test.ts.
 */
const NOT_PRODUCTION = new Set(["test", "development", "preview"]);

export function isProductionDeploy(): boolean {
  const app = process.env.APP_ENV;
  const vercel = process.env.VERCEL_ENV;
  if (vercel === "production" || app === "production") return true;
  if (app) return !NOT_PRODUCTION.has(app);
  if (vercel === "preview" || vercel === "development") return false;
  return process.env.NODE_ENV === "production";
}
