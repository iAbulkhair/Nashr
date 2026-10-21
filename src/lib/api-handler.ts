import { NextResponse } from "next/server";
import { z, type ZodType, type output } from "zod";
import { currentUser, isAdmin, sc, type User } from "./auth";
import { MULTI_ORG } from "./multi-org";
import { WS_HEADER, isNotFoundError, workspaceMissing } from "./ws-path";
import { allow, clientIp, retryLater } from "./rate";
import { forbid, type Action } from "./roles";
import { sameSecret } from "./secret";

/**
 * One wrapper for API route handlers (rules 1900-1906, 1907-1929 held; docs/system/architecture.md "API route wrapper"). Every route used
 * to repeat the same steps by hand: read the session, check the role, take the rate-limit hit, parse the JSON body and
 * check its fields. `handler(options, fn)` runs them in one fixed order and hands `fn` what passed:
 *
 *   1. authenticate: `currentUser()` (auth "user"), `isAdmin(req)` ("admin"), the CRON_SECRET bearer compared with
 *      `sameSecret` ("cron"), or nothing ("public"). A caller who fails gets 401 before anything else is read.
 *   2. `forbid(u, role)`: the 403 every route already answers (`{ error: "forbidden" }`, src/lib/roles.ts).
 *   3. the rate limit (`allow`, src/lib/rate.ts): 429 `{ ok: false, error: "slow_down" }` with `Retry-After`.
 *   4. `maxBytes`: 413 `too_large` from the Content-Length header, before the body is read.
 *   5. the query string, then the JSON body, each checked by its zod schema: 400 with a code from `ApiError`.
 *
 * `fn` gets `{ req, u, scope, input, query, params }`. `scope` is `sc(u)`, computed here from the session and never from
 * the request: a scope, email or id in the body or the query is only data to `fn`. Only "user" handlers get `u` and
 * `scope`. Nothing is caught: a throw from `fn` is the same 500 it was before.
 *
 * Bodies stay what each route answered before the wrapper (rule 1905): a refusal with no code is the bare `{ ok: false }`
 * many routes still send, so `unauthorized` and `invalid` name a code only where the route already had one. A zod issue
 * whose message is itself an `ApiError` (`z.custom(isAgentId, { error: "bad_agent" })`) answers that code, so a route
 * keeps one code per field. zod reports issues in the schema's key order, so the first failing field wins, as the
 * hand-written checks ran top to bottom.
 */

/**
 * Every error code a wrapped route answers. The strings are the ones the routes already sent, so the client maps in
 * src/lib/app-i18n.ts keep matching. A route converted later adds its own codes here.
 */
export const API_ERRORS = [
  "auth",
  "unauthorized",
  "forbidden",
  "slow_down",
  "too_large",
  "missing",
  "bad_input",
  "not_found",
  "busy",
  "exists",
  "file_limit",
  "bad_action",
  "bad_agent",
  "bad_kind",
  "bad_cursor",
  "too_short",
  "too_long",
  "unknown_item",
  "workspace_missing",
] as const;
export type ApiError = (typeof API_ERRORS)[number];
export const isApiError = (v: unknown): v is ApiError => typeof v === "string" && (API_ERRORS as readonly string[]).includes(v);

export type ApiAuth = "user" | "admin" | "cron" | "public";

/**
 * A rate limit, counted with `allow` from src/lib/rate.ts. The counter is `rate:<bucket>:<who>`: the account's email
 * ("account", the default for a user), the brand scope `sc(u)` ("scope"), or the client IP ("ip", and always when there
 * is no user). `window` is in seconds (`WINDOW.hour`, `WINDOW.day`); a refusal tells the caller to wait that long.
 */
export type RateRule = { bucket: string; max: number; window: number; per?: "account" | "scope" | "ip" };

type Schema = ZodType | undefined;
type Parsed<S> = S extends ZodType ? output<S> : undefined;

export type HandlerOptions<A extends ApiAuth, I extends Schema, Q extends Schema> = {
  auth: A;
  /** The action of src/lib/roles.ts the caller's role must allow. A signed-in user only. */
  role?: A extends "user" ? Action : never;
  rate?: RateRule;
  /** Refuse a body whose Content-Length is above this many bytes, before it is read. */
  maxBytes?: number;
  /** The JSON body. A body that is not JSON is checked as `{}`, as the routes' `req.json().catch(() => ({}))` did. */
  input?: I;
  /** The query string, as an object holding the first value of each name (what `searchParams.get` returns). */
  query?: Q;
  /** The 401 body's code. Omitted: the bare `{ ok: false }`. */
  unauthorized?: ApiError;
  /** The 400 body's code when the failing field names none. Omitted: the bare `{ ok: false }`. */
  invalid?: ApiError;
};

type Base<I, Q, P> = { req: Request; input: Parsed<I>; query: Parsed<Q>; params: P };
export type HandlerContext<A extends ApiAuth, I, Q, P> = Base<I, Q, P> & (A extends "user" ? { u: User; scope: string } : Record<never, never>);

/** A refusal: `{ ok: false }`, with `error` when there is a code. */
export const fail = (code: ApiError | undefined, status: number) => NextResponse.json(code ? { ok: false, error: code } : { ok: false }, { status });

/**
 * An optional query parameter checked by a type guard the codebase already has (`isAgentId`, `isActivityKind`): absent
 * or empty is `undefined`, anything else must pass `ok` or the request is refused with `code`.
 */
export const param = <T>(ok: (v: unknown) => v is T, code: ApiError) => z.preprocess((v) => v || undefined, z.custom<T>(ok, { error: code }).optional());

/** The query string as `searchParams.get` reads it: the first value of each name. */
function queryObject(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
  return out;
}

/** `value` checked by `schema`: the parsed value, or the 400 (the first issue's own code, else `invalid`). */
async function check(schema: ZodType, value: unknown, invalid: ApiError | undefined): Promise<{ ok: true; data: unknown } | { ok: false; res: Response }> {
  const r = await schema.safeParseAsync(value);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0]?.message;
  return { ok: false, res: fail(isApiError(first) ? first : invalid, 400) };
}

/**
 * A wrapped route: as a test calls it (the request alone) and as Next.js calls it (with the route context). Next.js's
 * generated route type check reads the last signature, whose context must not be optional.
 */
export type RouteHandler<P> = {
  (req: Request): Promise<Response>;
  (req: Request, ctx: { params: Promise<P> }): Promise<Response>;
};

export function handler<A extends ApiAuth, I extends Schema = undefined, Q extends Schema = undefined, P = Record<string, string>>(
  opts: HandlerOptions<A, I, Q>,
  fn: (ctx: HandlerContext<A, I, Q, P>) => Promise<Response> | Response,
): RouteHandler<P> {
  if (opts.role && opts.auth !== "user") throw new Error('api-handler: a role needs auth "user"');
  return async (req: Request, routeCtx?: { params: Promise<P> }) => {
    // 1. Who is calling. Nothing of the request is parsed before this answers.
    let u: User | null = null;
    if (opts.auth === "user") {
      // Multi-workspace M2 (rule 2113): a state-changing request that names no workspace writes nothing; the proxy
      // answers it first, this is the same check again for a route the proxy did not see. A foreign handle (or a brand
      // that is not the account's) is a JSON 404 with the switch on; with it off the route throws Next's 404 as on main.
      if (MULTI_ORG && workspaceMissing(req.method, new URL(req.url).pathname, true, req.headers.get(WS_HEADER))) return fail("workspace_missing", 409);
      try {
        u = await currentUser();
      } catch (e) {
        if (MULTI_ORG && isNotFoundError(e)) return fail("not_found", 404);
        throw e;
      }
      if (!u) return fail(opts.unauthorized, 401);
    } else if (opts.auth === "admin") {
      if (!(await isAdmin(req))) return fail(opts.unauthorized, 401);
    } else if (opts.auth === "cron") {
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!sameSecret(bearer, process.env.CRON_SECRET)) return fail(opts.unauthorized, 401);
    }
    // 2. What the caller's role allows.
    if (opts.role) {
      const no = forbid(u, opts.role);
      if (no) return no;
    }
    // 3. The rate limit, before any body is read.
    if (opts.rate) {
      const r = opts.rate;
      const who = !u || r.per === "ip" ? clientIp(req) : r.per === "scope" ? sc(u) : u.email;
      if (!(await allow(`${r.bucket}:${who}`, r.max, r.window))) return retryLater({ ok: false, error: "slow_down" }, r.window);
    }
    // 4. Size, then the query and the body.
    if (opts.maxBytes !== undefined && Number(req.headers.get("content-length") ?? 0) > opts.maxBytes) return fail("too_large", 413);
    let query: unknown = undefined;
    if (opts.query) {
      const q = await check(opts.query, queryObject(req), opts.invalid);
      if (!q.ok) return q.res;
      query = q.data;
    }
    let input: unknown = undefined;
    if (opts.input) {
      const b = await check(opts.input, await req.json().catch(() => ({})), opts.invalid);
      if (!b.ok) return b.res;
      input = b.data;
    }
    const params = (routeCtx?.params ? await routeCtx.params : {}) as P;
    const base = { req, input, query, params };
    // The scope comes from the session alone (sc(u)): never from the body, the query or the path.
    return fn((u ? { ...base, u, scope: sc(u) } : base) as HandlerContext<A, I, Q, P>);
  };
}
