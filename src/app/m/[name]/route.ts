import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { MEDIA_NAME } from "@/lib/media-catalog";
import { MEDIA_KEYS } from "@/lib/media/store";
import { storage } from "@/lib/media/storage";
import { shareValid } from "@/lib/media/share";
import { WINDOW, allow, clientIp, retryLater } from "@/lib/rate";

/**
 * Our media files (rules 1754-1758). Private by default: a file is served only
 *  - to a signed-in member whose current workspace (`sc(u)`) holds it in its index (`mfile:{scope}:{name}`), which is
 *    how the inbox shows it; or
 *  - to a request carrying a valid share signature (`?exp=&sig=`, src/lib/media/share.ts), which is how Meta, kie,
 *    Higgsfield, Composio and WordPress fetch it at the moment we hand it over.
 * Everything else, a bad name, a missing file and another workspace's file alike, is the same bare 404: the route never
 * says whether a name exists. The name is checked against MEDIA_NAME before any filesystem or store call, so no `/`,
 * `..`, `%`, NUL or uppercase reaches a path. The bytes come from the storage adapter (`storage()`, rule 2062), which is
 * asked only after the check above passed. GET and HEAD only.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });

/** Rule 1758: full-body streams over BIG_BYTES at once in this process. Range requests and small files are not counted. */
const MAX_BIG_STREAMS = 6;
const BIG_BYTES = 10 * 1024 * 1024;
let bigStreams = 0;

/** One `bytes=` range (rule 1757). "multi" for several (answered with the whole file), "bad" for unsatisfiable. */
function parseRange(h: string | null, size: number): { start: number; end: number } | "multi" | "bad" | null {
  if (!h) return null;
  const m = /^bytes=(.+)$/.exec(h.trim());
  if (!m) return null;
  if (m[1].includes(",")) return "multi";
  const r = /^(\d*)-(\d*)$/.exec(m[1].trim());
  if (!r || (r[1] === "" && r[2] === "")) return null;
  let start: number, end: number;
  if (r[1] === "") {
    const n = Number(r[2]);
    if (n === 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(r[1]);
    end = r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return "bad";
  return { start, end };
}

type Ctx = { params: Promise<{ name: string }> };
/** Rule 1758: per IP, before anything else, so guessing names costs the guesser and not the disk. */
const MAX_PER_HOUR = 1200;

async function serve(req: Request, ctx: Ctx, head: boolean): Promise<Response> {
  const { name } = await ctx.params;
  if (typeof name !== "string" || !MEDIA_NAME.test(name)) return notFound();

  const q = new URL(req.url).searchParams;
  const signed = q.has("sig") || q.has("exp");
  if (signed) {
    if (!shareValid(name, q.get("exp"), q.get("sig"))) return notFound();
  } else {
    const u = await currentUser();
    if (!u || !(await db.get(MEDIA_KEYS.entry(sc(u), name)))) return notFound();
  }

  const st = storage();
  const stat = await st.head(name);
  if (!stat) return notFound();

  const etag = `"${name.slice(0, 32)}"`;
  const download = q.get("download") === "1";
  const headers: Record<string, string> = {
    "content-type": stat.contentType,
    "accept-ranges": "bytes",
    // A signed link is for one fetcher at one moment; a member's browser may keep its own copy. Never a shared cache.
    "cache-control": signed ? "no-store" : "private, max-age=86400",
    etag,
    "last-modified": stat.mtime.toUTCString(),
    "content-disposition": download ? `attachment; filename="thakeen-${name.slice(0, 8)}.${name.slice(-3)}"` : "inline",
    // A provider could return a polyglot file: it must never run as a page on our origin (rule 1756).
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
    "x-robots-tag": "noindex, nofollow",
  };
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  const range = parseRange(req.headers.get("range"), stat.size);
  if (range === "bad") return new NextResponse(null, { status: 416, headers: { ...headers, "content-range": `bytes */${stat.size}` } });
  const part = range && range !== "multi" ? range : null;
  const start = part?.start ?? 0;
  const end = part?.end ?? stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  headers["content-length"] = String(length);
  if (part) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
  const status = part ? 206 : 200;
  if (head || length === 0) return new NextResponse(null, { status, headers });

  const big = !part && stat.size > BIG_BYTES;
  if (big && bigStreams >= MAX_BIG_STREAMS) return new NextResponse(null, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
  if (big) bigStreams++;
  let released = !big;
  const release = () => {
    if (!released) { released = true; bigStreams--; }
  };
  const stream = st.stream(name, { start, end });
  stream.once("close", release);
  stream.once("error", release);
  req.signal.addEventListener("abort", () => { stream.destroy(); release(); }, { once: true });
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status, headers });
}

export async function GET(req: Request, ctx: Ctx) {
  if (!(await allow(`mfile:${clientIp(req)}`, MAX_PER_HOUR, WINDOW.hour))) return retryLater(null, WINDOW.hour);
  return serve(req, ctx, false);
}
export async function HEAD(req: Request, ctx: Ctx) {
  if (!(await allow(`mfile:${clientIp(req)}`, MAX_PER_HOUR, WINDOW.hour))) return retryLater(null, WINDOW.hour);
  return serve(req, ctx, true);
}
