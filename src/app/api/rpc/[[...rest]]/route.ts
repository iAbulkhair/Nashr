import { currentUser } from "@/lib/auth";
import { baOn } from "@/lib/auth-engine";
import { handleRpc } from "@/lib/rpc/handler";

/**
 * The typed API, oRPC (rules 3421-3423, src/lib/rpc/router.ts). 404 while `AUTH_ENGINE` is not `better-auth`, so with
 * the switch off nothing here answers. On: the session is read first (the cookie only, never a bearer token), then the
 * RPC handler; every procedure refuses without a session. POST only (the client's default), so the proxy's same-origin
 * check covers every call (src/lib/csrf.ts); a GET, a PUT or a DELETE is Next's 405.
 */
export async function POST(req: Request) {
  if (!baOn()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const user = await currentUser();
  return handleRpc(req, user);
}
