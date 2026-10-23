import { onError, ORPCError } from "@orpc/server";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import type { User } from "@/lib/auth";
import { log } from "@/lib/log";
import { router } from "./router";

/** Where the procedures are served (Supastarter's /api/rpc); the client writes the same path out (src/lib/rpc/client.ts). */
export const RPC_PREFIX = "/api/rpc";
/** The largest request body read, in bytes: the biggest input is a device id and a password (rule 3422). */
export const RPC_MAX_BODY = 16 * 1024;

/**
 * One RPC handler for the process (rule 3422). The body limit runs before the body is parsed; the response-headers
 * plugin lets a procedure send `Retry-After` with a 429 (rule 680). An error that is not a
 * refusal leaves as oRPC's own INTERNAL_SERVER_ERROR "Internal server error" (never the message), and is logged with the
 * procedure's path and the error's name only: never the input, the message or the session.
 */
const handler = new RPCHandler(router, {
  plugins: [new BodyLimitPlugin({ maxBodySize: RPC_MAX_BODY }), new ResponseHeadersPlugin()],
  clientInterceptors: [
    onError((e, o) => {
      if (e instanceof ORPCError && e.status < 500) return;
      log.error("rpc_failed", { path: o.path.join("."), name: e instanceof Error ? e.name : typeof e });
    }),
  ],
});

/**
 * Serve one request for the session's user (null when signed out: every procedure is protected and answers
 * UNAUTHORIZED). A path no procedure matches answers the legacy 404. Answers are never stored by a cache.
 */
export async function handleRpc(req: Request, user: User | null): Promise<Response> {
  const { matched, response } = await handler.handle(req, { prefix: RPC_PREFIX, context: { user } });
  const res = matched ? response : Response.json({ ok: false, error: "not_found" }, { status: 404 });
  res.headers.set("cache-control", "no-store");
  return res;
}
