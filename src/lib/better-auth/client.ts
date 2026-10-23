import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * The wrapper's base path, written out: this module goes to the browser and must not import src/lib/better-auth/server.ts
 * (the server config, the adapter, Redis). tests/better-auth-client.test.ts checks it equals the server's `BA_BASE_PATH`.
 */
export const BA_CLIENT_BASE_PATH = "/api/better-auth";

/**
 * The browser's better-auth client (rule 3418, spec section 7), as Supastarter's `packages/auth/client.ts`: one
 * `createAuthClient` from `better-auth/react` with the magic-link plugin client. It talks only to Thakeen's wrapper
 * (src/lib/better-auth/handler.ts), which answers 404 for everything while AUTH_ENGINE is off and keeps its own allow-list
 * while it is on, so a client method for a path the wrapper does not serve gets a 404, never a better-auth endpoint.
 *
 * - The base is given, never read from an environment variable (better-auth's client would otherwise look at
 *   BETTER_AUTH_URL, NEXTAUTH_URL or VERCEL_URL): in the browser it is the page's own origin.
 * - `credentials: "same-origin"` instead of better-auth's default `include`: the cookie rides only to this origin.
 * - The default fetch plugins are off: the only one is a redirect that follows `{redirect: true, url}` in an answer, and
 *   the wrapper never sends a URL to follow (`redirect: false`).
 *
 * `fetchImpl` is for tests, which drive the real route handlers in-process.
 */
export function makeAuthClient(opts: { baseURL: string; fetchImpl?: typeof fetch }) {
  return createAuthClient({
    baseURL: opts.baseURL,
    basePath: BA_CLIENT_BASE_PATH,
    plugins: [magicLinkClient()],
    disableDefaultFetchPlugins: true,
    fetchOptions: { credentials: "same-origin", ...(opts.fetchImpl ? { customFetchImpl: opts.fetchImpl } : {}) },
  });
}

export type AuthClient = ReturnType<typeof makeAuthClient>;

let browserClient: AuthClient | null = null;

/**
 * The one client the screens use, made on first use in the browser. Queries and mutations run only there (a server render
 * of a component that holds a query hook fetches nothing), so the server never builds a client or guesses a base URL.
 */
export function authClient(): AuthClient {
  if (typeof window === "undefined") throw new Error("authClient() runs in the browser only");
  browserClient ??= makeAuthClient({ baseURL: window.location.origin });
  return browserClient;
}
