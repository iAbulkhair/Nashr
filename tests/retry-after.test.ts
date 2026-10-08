import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WINDOW, retryAfter, retryLater } from "@/lib/rate";

/**
 * Rule 680: every 429 tells the caller when to try again. A refusal by one of our buckets (`allow` in src/lib/rate.ts)
 * answers through `retryLater`, which sets `Retry-After` to the window that bucket was given; a 429 a library hands to a
 * route (Reem's day of new items, a media start) carries `retryAfter` for the route to send. Without the header a client
 * can only guess, and a guess that is too short keeps the counter full.
 */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });

/** A 429 written into a response: `status: 429`, or a 429 as the first argument (`answer(429, …)`). */
const BUILDS_429 = /\bstatus:\s*429\b|\(\s*429\s*[,)]/g;
/** The statement around a match: from the start of its line to the next semicolon, so a header on the next line counts. */
const statement = (src: string, at: number) => src.slice(src.lastIndexOf("\n", at) + 1, src.indexOf(";", at) + 1 || src.length);
/** A match on a comment line ("slow_down" (429) in a doc comment) builds nothing. */
const inComment = (src: string, at: number) => /^\s*(\*|\/\/|\/\*)/.test(src.slice(src.lastIndexOf("\n", at) + 1, at));
/** Where a 429 is built in `src` without what `sent` looks for in its statement. */
const missing = (src: string, sent: RegExp) =>
  [...src.matchAll(BUILDS_429)].filter((m) => !inComment(src, m.index) && !sent.test(statement(src, m.index))).map((m) => src.slice(0, m.index).split("\n").length);
const unsent = (files: string[], sent: RegExp) => files.flatMap((p) => missing(readFileSync(p, "utf8"), sent).map((line) => `${p}:${line}`));

describe("rule 680: a 429 says when to try again", () => {
  it("no API route builds a 429 without Retry-After: they all answer through retryLater", () => {
    expect(unsent(walk("src/app/api"), /retry-after/i)).toEqual([]);
  });

  it("a 429 a library hands to a route carries retryAfter; a tool's error text is not an HTTP answer", () => {
    expect(unsent(walk("src/lib"), /retryAfter|toolError\(/)).toEqual([]);
  });

  it("the scan catches the shapes it is meant to", () => {
    for (const src of [
      `return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });`,
      `const tooMany = () => new Response(null, { status: 429 });`,
      `export const rateLimited = () => Response.json({ error: "rate_limited" }, { status: 429 });`,
      `return answer(429);`,
    ]) expect(missing(src, /retry-after/i), src).toEqual([1]);
    for (const src of [
      `return retryLater({ ok: false, error: "slow_down" }, 3600);`,
      `return NextResponse.json(x, {\n  status: 429,\n  headers: { "Retry-After": "60" } });`,
      `return answer(429, { "retry-after": "3600" });`,
      `return NextResponse.json(body, { status: 400 });`,
      ` * Why a request failed, as one code: "network" (no answer), "slow_down" (429), the Turnstile codes`,
      `  // 429: the account's daily setup allowance, checked before any charge.`,
    ]) expect(missing(src, /retry-after/i), src).toEqual([]);
  });

  it("every one-line bucket refusal in an API route reports the window its allow() was given", () => {
    // `allow(bucket, max, W))) return retryLater(body, W)`: the same window on both sides of one line.
    const lines = walk("src/app/api").flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => ({ at: `${p}:${i + 1}`, line })));
    const inline = lines.filter((x) => /allow\(.*\)\)\) return retryLater\(/.test(x.line));
    expect(inline.length, "the scan finds the one-line refusals").toBeGreaterThanOrEqual(30);
    const mismatched = inline.filter((x) => {
      // The window is the last argument, or the one before the route's own headers.
      const m = /allow\(.*, ([\w.]+)\)\)\) return retryLater\(.*?, ([\w.]+)(?:, (?:HEADERS|cors))?\);$/.exec(x.line);
      return !m || m[1] !== m[2];
    });
    expect(mismatched.map((x) => x.at)).toEqual([]);
  });

  it("retryLater: 429, Retry-After in whole seconds, the route's body unchanged", async () => {
    const r = retryLater({ ok: false, error: "slow_down", retry: "hour" }, WINDOW.hour);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("3600");
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({ ok: false, error: "slow_down", retry: "hour" });
    expect(retryLater({ error: "rate_limited" }, WINDOW.day).headers.get("retry-after")).toBe("86400");
  });

  it("retryLater keeps the route's own headers, and sends a text or empty body as it is", async () => {
    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    const r = retryLater({ error: "slow_down" }, 900, cors);
    expect([r.headers.get("access-control-allow-origin"), r.headers.get("cache-control"), r.headers.get("retry-after")]).toEqual(["*", "no-store", "900"]);
    const text = retryLater("slow_down", 86400);
    expect([text.status, await text.text(), text.headers.get("retry-after")]).toEqual([429, "slow_down", "86400"]);
    const empty = retryLater(null, 3600, { "cache-control": "no-store" });
    expect([empty.status, await empty.text(), empty.headers.get("retry-after"), empty.headers.get("cache-control")]).toEqual([429, "", "3600", "no-store"]);
  });

  it("Retry-After is a whole number of seconds, at least one", () => {
    expect(retryAfter(10)).toEqual({ "Retry-After": "10" });
    expect(retryAfter(0.2)).toEqual({ "Retry-After": "1" });
    expect(retryAfter(0)).toEqual({ "Retry-After": "1" });
    expect(retryAfter(59.5)).toEqual({ "Retry-After": "60" });
  });
});
