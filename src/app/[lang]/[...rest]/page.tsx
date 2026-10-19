import { notFound } from "next/navigation";

/**
 * Anything under a language prefix that matches no real route. Without this, a mistyped path fell through to Next's
 * built-in "404: This page could not be found." — an untitled English document with no branding and no way back —
 * while a path that DID match a route and then called `notFound()` got the app's own 404. Same outcome for the owner,
 * two different pages. This routes both into `[lang]/not-found.tsx`.
 *
 * More specific segments always win over a catch-all, so every real route is unaffected. Rendered per request (rule
 * 2322), never `force-static`: a prerendered 404 has no CSP nonce on its scripts, and the enforced policy blocks them.
 */
export const dynamic = "force-dynamic";

export default function CatchAll() {
  notFound();
}
