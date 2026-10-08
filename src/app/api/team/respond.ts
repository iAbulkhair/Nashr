import { retryLater } from "@/lib/rate";
import type { TeamFail } from "@/lib/team";

/**
 * One mapping from a src/lib/team.ts failure to the HTTP answer every /api/team route gives (the JSON contracts in
 * docs/superpowers/specs/2026-09-29-teams-design.md §6). Not a route: no handler lives here.
 */
export function teamFail(f: TeamFail): Response {
  if (f.error === "seats") return Response.json({ error: "seats", used: f.used, limit: f.limit }, { status: 409 });
  const status = f.error === "forbidden" ? 403 : f.error === "not_found" ? 404 : f.error === "unavailable" ? 409 : 400;
  return Response.json({ error: f.error }, { status });
}

export const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
/** 429 with `Retry-After`: the window, in seconds, of the bucket that refused. */
export const rateLimited = (windowSeconds: number) => retryLater({ error: "rate_limited" }, windowSeconds);
