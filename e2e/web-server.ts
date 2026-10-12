import { existsSync } from "node:fs";
import { join } from "node:path";

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
