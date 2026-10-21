import { headers } from "next/headers";
import { BRAND_HEADER, isBrandId } from "./brand-path";
import { MULTI_ORG } from "./multi-org";
import { WS_HEADER, appHref, asHandle } from "./ws-path";

/**
 * The link builder for the page being rendered, with both selectors its own link names (rules 889, 2113): the brand of
 * its `/b/{id}` segment and, with `MULTI_ORG` on, the workspace of its `/w/{handle}` segment. The proxy set both headers
 * from the path and stripped any the browser sent; `currentUser()` has already answered 404 for a handle or a brand
 * that is not the caller's. `const href = await pageHref(lang); href("/tasks")`; `href("/start", u.brandId)` names the
 * brand itself (a page outside `/b/{id}` sending the person into a brand section). With `MULTI_ORG` off this is exactly
 * brand-path.ts `appHref(lang, path, { brand })`.
 */
export async function pageHref(lang: string): Promise<(path?: string, brand?: string | null) => string> {
  const { handle, brand: pageBrand } = await pageSelectors();
  return (path = "", brand) => appHref(lang, path, handle, brand === undefined ? pageBrand : brand);
}

/** The page's own workspace handle (null with `MULTI_ORG` off) and brand id, as `pageHref` reads them; for an `apiHref`-style query link. */
export async function pageSelectors(): Promise<{ handle: string | null; brand: string | null }> {
  const h = await headers();
  const own = h.get(BRAND_HEADER);
  return { handle: MULTI_ORG ? asHandle(h.get(WS_HEADER)) : null, brand: isBrandId(own) ? own : null };
}
