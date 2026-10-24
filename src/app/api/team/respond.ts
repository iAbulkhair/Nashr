import { retryLater } from "@/lib/rate";
import type { TeamFail } from "@/lib/team";

/**
 * One mapping from a src/lib/team.ts failure to the HTTP answer every /api/team route gives (the JSON contracts in
 * docs/superpowers/specs/2026-09-29-teams-design.md §6). Not a route: no handler lives here.
 */
export function teamFail(f: TeamFail): Response {
  // Rule 4047: a seat charged in this request and refunded because the invite could not be made after all.
  const refunded = f.refunded ? { refunded: true } : {};
  if (f.error === "seats") {
    // The paid-seat fields (rule 3369) only when the invite path set them: the confirm step reads them. On a yearly
    // subscription also the amount charged now or why no seat is sold online (rules 4040, 4049).
    const paid = f.canBuy !== undefined ? { included: f.included, extra: f.extra, unitSar: f.unitSar, canBuy: f.canBuy, ...(f.charge ? { charge: f.charge } : {}), ...(f.blocked ? { blocked: f.blocked } : {}) } : {};
    return Response.json({ error: "seats", used: f.used, limit: f.limit, ...paid, ...refunded }, { status: 409 });
  }
  if (f.error === "busy") return f.refunded ? Response.json({ error: "busy", ...refunded }, { status: 409 }) : busy();
  // A yearly seat charged now (rule 4045): the card refused it (402), the provider failed before charging (502), or it
  // is still in flight, another is, or the subscription moved (409). No seat and no invite in any of them.
  const status =
    f.error === "forbidden" ? 403
    : f.error === "not_found" ? 404
    : f.error === "seat_declined" ? 402
    : f.error === "seat_failed" ? 502
    : f.error === "unavailable" || f.error === "already_member" || f.error === "signin_required" || f.error === "seat_busy" || f.error === "seat_pending" || f.error === "seat_changed" ? 409
    : 400;
  return Response.json({ error: f.error, ...refunded }, { status });
}

/** 409 `busy`: a person lock (`lock:person:{pid}`) was not taken in time; nothing was half-applied that a retry cannot finish. */
export const busy = () => Response.json({ error: "busy" }, { status: 409 });

export const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
/** 429 with `Retry-After`: the window, in seconds, of the bucket that refused. */
export const rateLimited = (windowSeconds: number) => retryLater({ error: "rate_limited" }, windowSeconds);
