import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { avatarSig } from "@/lib/avatar";
import { globalKey } from "@/lib/keys";
import { MEDIA_NAME } from "@/lib/media-catalog";
import { storage } from "@/lib/media/storage";
import { WINDOW, allow, clientIp, retryLater } from "@/lib/rate";
import { sameSecret } from "@/lib/secret";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
/** Per IP and hour, before anything else (as `/m/`): a page of 50 team members is 50 requests. */
const MAX_PER_HOUR = 1200;

/**
 * GET /api/avatar/{name}?s= (rule 3503): a person's picture, to a signed-in user only. `s` is `avatarSig(name)`, which
 * only our server can make (HMAC under a key derived from CONNECT_SECRET), compared with `sameSecret`; the name is
 * checked against MEDIA_NAME before the store is asked. A bad name, a bad signature, no session and a missing file are
 * the same bare 404. Served as an inert JPEG (sandbox CSP, nosniff), cached by the browser only.
 */
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (!(await allow(globalKey.avatarGetBucket(clientIp(req)), MAX_PER_HOUR, WINDOW.hour))) return retryLater(null, WINDOW.hour);
  const { name } = await ctx.params;
  if (typeof name !== "string" || !MEDIA_NAME.test(name) || !name.endsWith(".jpg")) return notFound();
  if (!sameSecret(new URL(req.url).searchParams.get("s"), avatarSig(name))) return notFound();
  if (!(await currentUser())) return notFound();
  const st = storage();
  const stat = await st.head(name);
  if (!stat || stat.contentType !== "image/jpeg") return notFound();
  const etag = `"a${name.slice(0, 32)}"`;
  const headers: Record<string, string> = {
    "content-type": "image/jpeg",
    "cache-control": "private, max-age=86400",
    etag,
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "x-robots-tag": "noindex, nofollow",
  };
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });
  headers["content-length"] = String(stat.size);
  return new NextResponse(Readable.toWeb(st.stream(name)) as ReadableStream, { status: 200, headers });
}
