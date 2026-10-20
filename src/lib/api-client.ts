import { WS_HEADER, handleOfPath } from "./ws-path";

/**
 * The browser's half of the workspace in the link (multi-workspace M2, docs/specs/2026-10-18-multi-org.md section 7
 * "Where the handle comes from", rule 2113). A same-origin request to `/api/` from a page at `/{lang}/app/w/{handle}/…`
 * carries that page's handle in `x-thakeen-ws`, so each tab writes into its own workspace and a state-changing request
 * is never answered `workspace_missing`. The server treats the value as a selector among the caller's own accounts only.
 *
 * The app's screens call `fetch("/api/…")` directly (about 120 calls), so the header is added by wrapping
 * `window.fetch` once, from the shell's provider (src/components/app/WorkspaceContext.tsx) and only while `MULTI_ORG` is
 * on. Part C (brand in the link) adds its brand header here too. The only native form posts go to routes outside the
 * guard (`/api/oauth/approve`, `/api/staging-access`, `/api/admin/impersonate`).
 */

/** The handle a request to `input` should carry from a page at `pagePath`, or null (another site, not `/api/`, no handle). */
export function wsHeaderFor(input: RequestInfo | URL, pagePath: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return null;
  return handleOfPath(pagePath);
}

/** `init` with the workspace header added, unless the caller set one already. */
export function withWsHeader(input: RequestInfo | URL, init: RequestInit | undefined, handle: string): RequestInit {
  const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
  if (!headers.has(WS_HEADER)) headers.set(WS_HEADER, handle);
  return { ...init, headers };
}

let installed = false;

/** Wrap `window.fetch` once so app requests name their page's workspace. Idempotent; a no-op on the server. */
export function installWorkspaceFetch(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const h = wsHeaderFor(input, window.location.pathname, window.location.origin);
    return h ? real(input, withWsHeader(input, init, h)) : real(input, init);
  };
}
