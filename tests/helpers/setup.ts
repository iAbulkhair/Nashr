import { vi } from "vitest";

/**
 * Route handlers read the session from next/headers and schedule follow-up work with next/server `after`. Neither exists
 * outside a request, so tests get a cookie jar they control (tests/helpers/session.ts) and `after` runs at once.
 */
type Jar = Map<string, string>;
/** Every `set` and `delete` the handlers made, with the options they passed (the path of a cookie is part of its name). */
type CookieCall = { op: "set" | "delete"; name: string; options: Record<string, unknown> };
const g = globalThis as unknown as { __testJar?: Jar; __testAfter?: Promise<unknown>[]; __testAfterInScope?: boolean; __testHeaders?: Record<string, string>; __testCookieCalls?: CookieCall[] };
g.__testJar ??= new Map();
g.__testAfter ??= [];
g.__testCookieCalls ??= [];
// `after()` is only callable while a request is being handled. The mock used to accept it anywhere, which made the
// `catch` fallback in cron-batch.ts and judge.ts unreachable in every test: the branch that runs when a cron chain
// continues outside a request was never once executed. `outsideRequestScope()` in ./session.ts flips this.
g.__testAfterInScope ??= true;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (g.__testJar!.has(name) ? { name, value: g.__testJar!.get(name)! } : undefined),
    set: (a: string | ({ name: string; value: string } & Record<string, unknown>), value?: string, options?: Record<string, unknown>) => {
      const { name, value: v, ...rest } = typeof a === "string" ? { ...(options ?? {}), name: a, value: value ?? "" } : a;
      g.__testJar!.set(name, v);
      g.__testCookieCalls!.push({ op: "set", name, options: rest });
    },
    // `delete(name)` or `delete({ name, path, domain })`, as Next accepts.
    delete: (a: string | ({ name: string } & Record<string, unknown>)) => {
      const { name, ...options } = typeof a === "string" ? { name: a } : a;
      g.__testJar!.delete(name);
      g.__testCookieCalls!.push({ op: "delete", name, options });
    },
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
