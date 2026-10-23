/**
 * Placeholder picture hosts for local work only (rule 3344): placehold.co and picsum.photos, for `next/image` while a
 * page is drafted. Import-free; next.config.ts reads it. Any `NODE_ENV` but "production" gets them; a production build
 * (`next build`, Hostinger's included) gets none, so the live site never fetches a placeholder through its image
 * optimizer, and the page policy is not touched in any environment (its report-only img-src already takes https).
 * A placeholder must never reach a shipped page: the build would refuse its host.
 */
export type DevImagePattern = { protocol: "https"; hostname: string; pathname: string };

export const DEV_IMAGE_HOSTS = ["placehold.co", "picsum.photos"] as const;

export function devImagePatterns(nodeEnv: string | undefined): DevImagePattern[] {
  if (nodeEnv === "production") return [];
  return DEV_IMAGE_HOSTS.map((hostname) => ({ protocol: "https", hostname, pathname: "/**" }));
}
