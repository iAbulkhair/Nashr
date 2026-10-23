import { handleBetterAuth } from "@/lib/better-auth/handler";

/**
 * better-auth's HTTP surface (rules 3400, 3410-3414). 404 for every path while `AUTH_ENGINE` is not `better-auth`; with it
 * on, only the allow-list in src/lib/better-auth/handler.ts (`BA_ROUTES`), rate-limited, through the one session cookie.
 * Thakeen's own sign-in routes stay at `/api/auth/*`.
 */
export const GET = (req: Request) => handleBetterAuth(req);
export const POST = (req: Request) => handleBetterAuth(req);
