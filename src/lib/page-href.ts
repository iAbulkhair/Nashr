import { headers } from "next/headers";
import { MULTI_ORG } from "./multi-org";
import { WS_HEADER, appHref, asHandle } from "./ws-path";

/**
 * The link builder for the page being rendered: the workspace its own link names (the proxy set the header from the
 * path and stripped any the browser sent; `currentUser()` has already answered 404 for a handle that is not the
 * caller's). `const href = await pageHref(lang); href("/tasks")`.
 */
export async function pageHref(lang: string): Promise<(path?: string) => string> {
  const handle = MULTI_ORG ? asHandle((await headers()).get(WS_HEADER)) : null;
  return (path = "") => appHref(lang, path, handle);
}
