import type { Instrumentation } from "next";
import { log } from "@/lib/log";
import { REQUEST_ID_HEADER, REQUEST_ID_SHAPE } from "@/lib/request-id";

/**
 * Server errors Next caught while rendering a page, running a route handler, a server action or the proxy (rule 1976).
 * One log line each, through the logger, so a failure that reached the browser as a bare 500 or an error page is in the
 * host's log with the request id the browser was given (src/proxy.ts, rule 1975).
 *
 * Only what is safe to keep is written: the path without its query (a query can carry a token or an email), the method,
 * the route file and kind, the error's class and status (`errorTag`, through the logger) and React's digest. Never the
 * message, the stack, the headers or the body. Nothing is sent to a third party: there is no error service yet.
 */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  const header = request.headers[REQUEST_ID_HEADER];
  const rid = typeof header === "string" && REQUEST_ID_SHAPE.test(header) ? header : undefined;
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest).slice(0, 40) : undefined;
  log.error("request failed", {
    rid,
    method: request.method,
    path: request.path.split("?")[0].slice(0, 200),
    route: context.routePath,
    kind: context.routeType,
    digest,
    error: err instanceof Error ? err : "thrown value",
  });
};
