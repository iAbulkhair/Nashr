import { vi } from "vitest";

/**
 * Route handlers read the session from next/headers and schedule follow-up work with next/server `after`. Neither exists
 * outside a request, so tests get a cookie jar they control (tests/helpers/session.ts) and `after` runs at once.
 */
type Jar = Map<string, string>;
const g = globalThis as unknown as { __testJar?: Jar; __testAfter?: Promise<unknown>[]; __testAfterInScope?: boolean; __testHeaders?: Record<string, string> };
g.__testJar ??= new Map();
g.__testAfter ??= [];
// `after()` is only callable while a request is being handled. The mock used to accept it anywhere, which made the
// `catch` fallback in cron-batch.ts and judge.ts unreachable in every test: the branch that runs when a cron chain
// continues outside a request was never once executed. `outsideRequestScope()` in ./session.ts flips this.
g.__testAfterInScope ??= true;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (g.__testJar!.has(name) ? { name, value: g.__testJar!.get(name)! } : undefined),
    set: (a: string | { name: string; value: string }, value?: string) => { if (typeof a === "string") g.__testJar!.set(a, value ?? ""); else g.__testJar!.set(a.name, a.value); },
    delete: (name: string) => { g.__testJar!.delete(name); },
  }),
  // Settable, because whether a cookie is marked Secure depends on the request's host and protocol.
  headers: async () => new Headers(g.__testHeaders ?? {}),
}));

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    if (!g.__testAfterInScope) throw new Error("`after()` was called outside a request scope.");
    g.__testAfter!.push(Promise.resolve().then(fn));
  },
}));
