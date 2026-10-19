import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PAGE_PREFIX_BYTES, responsePrefix } from "@/lib/read-capped";
import { crawl } from "@/lib/crawl";
import { discoverProductUrls } from "@/lib/catalog";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rule 2246 (docs/system/tests/2240-key-check-rate.md): a page or sitemap of a site a user names (the onboarding crawl,
 * the no-key catalog import) is read only up to its first 2 MB, the rest never pulled, and the crawl's 9 s deadline
 * covers the body as well as the headers, so a site that never ends or drips its page cannot fill the memory or hold
 * the request.
 */

const MB = 1024 * 1024;
const enc = new TextEncoder();
/** A body that starts with `head` and then never ends; counts the 1 MB chunks pulled. */
function endless(head: string, signal?: AbortSignal | null) {
  const seen = { pulls: 0, cancelled: false };
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      signal?.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")));
    },
    pull(ctl) {
      seen.pulls++;
      ctl.enqueue(first ? enc.encode(head) : new Uint8Array(MB).fill(0x20));
      first = false;
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pages and sitemaps of a named site are read up to 2 MB (rule 2246)", () => {
  it("keeps the first bytes, cancels the rest; a short body is whole; a split character becomes U+FFFD", async () => {
    expect(await responsePrefix(new Response("short page"), 100)).toBe("short page");
    const { body, seen } = endless("<html>");
    const text = await responsePrefix(new Response(body), 3 * MB);
    expect(text.startsWith("<html>")).toBe(true);
    expect(enc.encode(text).byteLength).toBe(3 * MB);
    expect(seen.pulls).toBeLessThanOrEqual(5);
    expect(seen.cancelled).toBe(true);
    expect(await responsePrefix(new Response("أ"), 1)).toBe("�");
    expect(PAGE_PREFIX_BYTES).toBe(2 * MB);
  });

  it("the crawl reads a page that never ends up to the cap and still finds its title", async () => {
    const streams: { pulls: number; cancelled: boolean }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const e = endless(`<html><head><title>Endless Store</title></head><body>${"word ".repeat(40)}`, init?.signal);
      streams.push(e.seen);
      return new Response(e.body, { headers: { "content-type": "text/html" } });
    }));
    const snap = await crawl("https://endless.example");
    expect(snap.title).toBe("Endless Store");
    expect(snap.ok).toBe(true);
    expect(streams[0].pulls).toBeLessThanOrEqual(PAGE_PREFIX_BYTES / MB + 2);
    expect(streams[0].cancelled).toBe(true);
  });

  it("the crawl's deadline covers the body: a page that sends its head and then nothing ends at 9 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(enc.encode("<html><title>Drip</title>"));
          init?.signal?.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { headers: { "content-type": "text/html" } });
    }));
    const pending = crawl("https://drip.example");
    await vi.advanceTimersByTimeAsync(9_001);
    const snap = await pending;
    expect(snap.ok).toBe(false);
    expect(snap.error).toBeTruthy();
  });

  it("the catalog import takes product links from the start of a sitemap that never ends", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith("/sitemap.xml")) {
        const e = endless('<?xml version="1.0"?><urlset><url><loc>https://shop.example/products/oud</loc></url>', init?.signal);
        return new Response(e.body, { headers: { "content-type": "application/xml" } });
      }
      return new Response("", { status: 404 });
    }));
    expect(await discoverProductUrls("shop.example", 5)).toContain("https://shop.example/products/oud");
  });

  it("neither file reads a whole body: no res.text() or res.json() left", () => {
    for (const f of ["src/lib/crawl.ts", "src/lib/catalog.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/\.(?:text|json|arrayBuffer|blob)\(\)/);
      expect(src).toContain("responsePrefix(");
    }
    expect(readFileSync("src/lib/crawl.ts", "utf8")).toContain("responsePrefix(res, PAGE_PREFIX_BYTES).finally(() => clearTimeout(t))");
  });
});
