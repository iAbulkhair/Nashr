import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { User } from "@/lib/auth";
import { retryAfter } from "@/lib/rate";
import { devicesFor, endDeviceFor, passkeysFor, type Refusal, type Result } from "@/lib/account-security";

/**
 * The typed API (rules 3421-3422, docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md section 8), as
 * Supastarter's packages/api/orpc: a public base with the request's context, a `protectedProcedure` that refuses without a
 * session, and one router object whose type the browser client imports (type only, so no server code reaches a bundle).
 *
 * The context is the session's user, read by the route (`currentUser()`, the session cookie only: an MCP or OAuth bearer
 * token never reaches a procedure). No procedure takes an address, a person id, an account or a scope from its input;
 * each composes src/lib/account-security.ts, which takes the login from `actingLogin(user)`.
 */
export type RpcContext = { user: User | null; resHeaders?: Headers };

const CODE = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
} as const satisfies Record<Refusal["status"], string>;

/** A refusal as an oRPC error: the HTTP status and code of the REST answer, and its legacy code in `data.error`. */
export function rpcRefusal(r: Refusal): ORPCError<(typeof CODE)[Refusal["status"]], { error: string }> {
  return new ORPCError(CODE[r.status], { status: r.status, message: r.error, data: { error: r.error } });
}

/** The value, or the refusal thrown; a 429 first sets `Retry-After` to its bucket's window, as REST's `retryLater` (rule 680). */
function unwrap<T>(r: Result<T>, resHeaders?: Headers): T {
  if (r.ok) return r.value;
  if (r.refusal.retryAfter) for (const [k, v] of Object.entries(retryAfter(r.refusal.retryAfter))) resHeaders?.set(k, v);
  throw rpcRefusal(r.refusal);
}

export const publicProcedure = os.$context<RpcContext>();

/** Signed in, or UNAUTHORIZED before the input is validated or anything is read (Supastarter's `protectedProcedure`). */
export const protectedProcedure = publicProcedure.use(({ context, next }) => {
  if (!context.user) throw rpcRefusal({ status: 401, error: "unauthorized" });
  return next({ context: { user: context.user } });
});

/** A device id is 20 hex characters (src/lib/devices.ts); the bound is generous so a bad id answers `not_found` as in REST. */
const RevokeInput = z.object({ id: z.string().max(64), password: z.string().max(1024) });

export const router = publicProcedure.router({
  account: {
    devices: {
      /** GET /api/account/sessions's `devices`. */
      list: protectedProcedure.handler(async ({ context }) => unwrap(await devicesFor(context.user))),
      /** DELETE /api/account/sessions: end one other device, with the login's password. */
      revoke: protectedProcedure.input(RevokeInput).handler(async ({ context, input }) => {
        unwrap(await endDeviceFor(context.user, input.id, input.password), context.resHeaders);
        return { ok: true as const };
      }),
    },
    passkeys: {
      /** GET /api/account/passkeys without its `ok`. */
      list: protectedProcedure.handler(async ({ context }) => unwrap(await passkeysFor(context.user))),
    },
  },
});

export type AppRouter = typeof router;
