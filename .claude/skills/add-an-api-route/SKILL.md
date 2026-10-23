---
name: add-an-api-route
description: Use when adding or changing a Next.js route handler under src/app/api (auth, role, rate limit, body check, tenant scope).
---

# Add an API route

Thakeen has no RPC layer: every endpoint is a `route.ts` file. New and changed routes use `handler(options, fn)` from `src/lib/api-handler.ts`, which runs the same five checks in a fixed order (authenticate, role, rate limit, `maxBytes`, query and body by zod). Read `docs/system/architecture.md` "API route wrapper" first.

## Steps

1. Pick the auth: `"user"` (`currentUser()`), `"admin"` (`isAdmin(req)`), `"cron"` (the `CRON_SECRET` bearer through `sameSecret`) or `"public"`. A public route needs a rate limit from `src/lib/rate.ts` (`allow`, `WINDOW`, `clientIp`, `retryLater`) and a body cap.
2. Create `src/app/api/<area>/route.ts` (a dynamic id is a folder like `[id]`). Export only HTTP method handlers and route config: `tests/route-exports.test.ts` fails on any other export. Shared constants go in `src/lib`.
3. Write each method as `export const POST = handler({ auth: "user", role: "<action>", rate: {...}, maxBytes, input: z.object({...}), invalid: "missing" }, async ({ u, scope, input }) => ...)`. Use a `role` action that exists in `MIN_ROLE` in `src/lib/roles.ts`; add the action there if none fits, and add it to `IMPERSONATION_BLOCKED` when a founder acting as the owner must not do it.
4. Use `scope` (that is `sc(u)`) for every tenant read or write. Never build a Redis key from a body, query or path value. Keys come from `src/lib/keys.ts` builders (see add-a-workspace-scoped-feature).
5. Answer with the error codes of the `ApiError` union in `src/lib/api-handler.ts`; add a new code there only if the client needs it, and add its Arabic and English text to the client map in `src/lib/app-i18n.ts` (see add-arabic-and-english-copy).
6. A webhook or other cookie-less caller is a state-changing route without a browser: add its path to `CROSS_SITE_EXEMPT` in `src/lib/csrf.ts` and prove the caller in the handler (signature over the raw body, compared in constant time).
7. User-supplied URLs are fetched only through `safeFetch` in `src/lib/safe-fetch.ts`. Spending credits goes through `src/lib/credits.ts`, and publishing or brand changes are checked in code, not only in a prompt.
8. Redis is HTTP per command: no `await db.*` inside a loop. Use `Promise.all` or `pmap` from `src/lib/parallel.ts`.
9. Update the docs in the same commit: a row in `docs/system/permissions.md` section 1 (who may call it, role, scope), the route list in `docs/system/architecture.md` section 2.4, and the step list in `docs/system/flows.md` if it adds a flow.
10. Tests: a unit test that calls the exported `GET`/`POST` directly (see write-a-unit-test), plus a signed-out 401, a wrong-role 403 and a cross-tenant case. `tests/role-gates.test.ts` reads each wrapped handler's `auth`, `role` and `rate` options, so a route missing from its table fails there.

## Checks

`npx vitest run tests/<your>.test.ts tests/route-exports.test.ts tests/role-gates.test.ts tests/routes-isolation.test.ts`, then `npm run check` and `npx next build` before any push.

## Traps

- Reading the scope, email or account id from the request. `scope` from `handler` is the only source; the brand id is a selector among the session account's own active brands.
- `Bearer` secrets compared with `===`: use `sameSecret` (`src/lib/secret.ts`). Never accept a secret in a URL and never log one.
- Returning the whole stored record. List the fields you send (rule 787): a field added later must not leak by default.
- Streaming or long routes read `maxDuration` only on Vercel; Hostinger decides the real limit (architecture "Environments").
- Model output rendered as HTML must pass `render` in `src/lib/md.ts`; CSV cells pass `csvSafe`.
