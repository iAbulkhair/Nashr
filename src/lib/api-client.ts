import { BRAND_HEADER, brandFromPath } from "./app-href";

/**
 * `fetch` for the app's own API from the browser (rule 889). It sets `x-thakeen-brand` from the `/b/{id}` segment of
 * the page, so a call made from a brand page names that brand. The header is a hint: the server checks the brand
 * against the caller's scope. A header given in `init` is kept. Only same-origin `/api/` paths are accepted.
 */
export async function api(input: string, init?: RequestInit): Promise<Response> {
  if (typeof input !== "string" || !input.startsWith("/api/")) throw new Error("api() takes a path that starts with /api/");
  const headers = new Headers(init?.headers);
  if (!headers.has(BRAND_HEADER)) {
    const brand = typeof location === "undefined" ? null : brandFromPath(location.pathname);
    if (brand) headers.set(BRAND_HEADER, brand);
  }
  return fetch(input, { ...init, headers });
}
