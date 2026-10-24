import { retryLater } from "@/lib/rate";
import type { TeamFail } from "@/lib/team";

/**
 * One mapping from a src/lib/team.ts failure to the HTTP answer every /api/team route gives (the JSON contracts in
 * docs/superpowers/specs/2026-09-29-teams-design.md §6). Not a route: no handler lives here.
 */
export function teamFail(f: TeamFail): Response {
  if (f.error === "seats") {
    // The paid-seat fields (rule 3369) only when the invite path set them: the confirm step reads them.
    const paid = f.canBuy !== undefined ? { included: f.included, extra: f.extra, unitSar: f.unitSar, canBuy: f.canBuy } : {};
    return Response.json({ error: "seats", used: f.used, limit: f.limit, ...paid }, { status: 409 });
  }
  if (f.error === "busy") return busy();
  const status = f.error === "forbidden" ? 403 : f.error === "not_found" ? 404 : f.error === "unavailable" || f.error === "already_member" || f.error === "signin_required" ? 409 : 400;
  return Response.json({ error: f.error }, { status });
}

/** 409 `busy`: a person lock (`lock:person:{pid}`) was not taken in time; nothing was half-applied that a retry cannot finish. */
export const busy = () => Response.json({ error: "busy" }, { status: 409 });

export const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
/** 429 with `Retry-After`: the window, in seconds, of the bucket that refused. */
export const rateLimited = (windowSeconds: number) => retryLater({ error: "rate_limited" }, windowSeconds);
