import { vi } from "vitest";

/**
 * Route handlers read the session from next/headers and schedule follow-up work with next/server `after`. Neither exists
 * outside a request, so tests get a cookie jar they control (tests/helpers/session.ts) and `after` runs at once.
 */
type Jar = Map<string, string>;
const g = globalThis as unknown as { __testJar?: Jar; __testAfter?: Promise<unknown>[] };
g.__testJar ??= new Map();
g.__testAfter ??= [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (g.__testJar!.has(name) ? { name, value: g.__testJar!.get(name)! } : undefined),
    set: (a: string | { name: string; value: string }, value?: string) => { if (typeof a === "string") g.__testJar!.set(a, value ?? ""); else g.__testJar!.set(a.name, a.value); },
    delete: (name: string) => { g.__testJar!.delete(name); },
  }),
  headers: async () => new Headers(),
}));

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { g.__testAfter!.push(Promise.resolve().then(fn)); },
}));
