import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mdToHtml, publishWordPress, verifyWordPress } from "@/lib/connectors/wordpress";
import type { Connection } from "@/lib/connectors/store";
import { verifyOdoo, verifyPrestaShop } from "@/lib/connectors/keyed";
import { discoverProductUrls } from "@/lib/catalog";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rules 2960-2963 (docs/system/tests/2960-connector-review.md): fixes from the files, media and outbound-fetch review.
 * Model text is untrusted on its way into a customer's own site; credentials never cross the wire in clear; the catalog
 * import's homepage fallback keeps to the store's own host; the privacy export lists brands under the account key.
 */
afterEach(() => vi.unstubAllGlobals());

describe("the WordPress body escapes model text (rule 2960)", () => {
  it("a quote in a link target cannot close the href and add an attribute", () => {
    const html = mdToHtml('[read more](https://a.example/" autofocus onfocus=alert`1`)');
    expect(html).toMatch(/<a href="[^"]*">read more<\/a>/);
    expect(html).not.toMatch(/<a href="[^"]*"\s+\w/);
  });

  it("a javascript: target never becomes a link", () => {
    expect(mdToHtml("[x](https:javascript:alert(1))")).toContain('href="#"');
  });

  it("tags and quotes in headings, lists and paragraphs come out as text", () => {
    const html = mdToHtml('# Offer <img src=x onerror="go()">\n- "quoted" <b>\nplain > text');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;go()&quot;&gt;");
    expect(html).toContain("&gt; text");
  });

  it("ordinary links, bold and lists still render", () => {
    const html = mdToHtml("## Title\n- **one**\n- [two](https://shop.example/p?a=1&b=2)");
    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<strong>one</strong>");
    expect(html).toMatch(/<a href="https:\/\/shop\.example\/p\?a=1&amp;b=2">two<\/a>/);
  });
});

describe("the WordPress title is sent as entities (rule 3011)", () => {
  const wp = { provider: "wordpress", data: { site: "https://blog.example.com", username: "owner", appPassword: "abcd efgh" }, connectedAt: "" } as Connection;
  const sent = () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return Response.json({ id: 7, link: "https://blog.example.com/?p=7", status: "draft" });
    }));
    return bodies;
  };

  it("a planted tag in a new post's title reaches the site as text", async () => {
    const bodies = sent();
    await publishWordPress(wp, { title: 'Sale <img src=x onerror="go()">', body: "text" });
    expect(bodies.at(-1)?.title).toBe("Sale &lt;img src=x onerror=&quot;go()&quot;&gt;");
  });

  it("an update in place escapes the title too", async () => {
    const bodies = sent();
    await publishWordPress(wp, { title: "<script>x</script>", body: "text", updateId: "7" });
    expect(bodies.at(-1)?.title).toBe("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("credentialed store calls are https only (rule 2961)", () => {
  const fetchSpy = () => {
    const f = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("WordPress refuses an http:// site before sending the application password", async () => {
    const f = fetchSpy();
    const r = await verifyWordPress({ site: "http://blog.example.com", username: "owner", appPassword: "abcd efgh" });
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("PrestaShop and Odoo refuse an http:// site before sending the key", async () => {
    const f = fetchSpy();
    expect((await verifyPrestaShop({ site: "http://shop.example.com", apiKey: "KEY" })).ok).toBe(false);
    expect((await verifyOdoo({ url: "http://erp.example.com", db: "d", username: "u", apiKey: "KEY" })).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("every safeFetch in the two connector files asks for https", () => {
    for (const file of ["src/lib/connectors/wordpress.ts", "src/lib/connectors/keyed.ts"]) {
      const src = readFileSync(file, "utf8");
      const calls = src.split("safeFetch(").length - 1;
      expect(calls, file).toBeGreaterThan(0);
      expect(src.split("httpsOnly: true").length - 1, file).toBe(calls);
    }
  });
});

describe("the catalog's homepage fallback keeps to the store's own host (rule 2962)", () => {
  it("a look-alike host that merely starts with the store's origin is not kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL) => {
      const url = new URL(String(u));
      if (url.hostname === "shop.example" && url.pathname === "/") {
        return new Response('<a href="https://shop.example.evil.example/products/x">x</a><a href="/products/oud">oud</a>', { headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    }));
    const urls = await discoverProductUrls("shop.example", 10);
    expect(urls).toContain("https://shop.example/products/oud");
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
  });
});

describe("the privacy export lists brands under the account key (rule 2963)", () => {
  it("buildExport reads the account's brands by acct(u), as wipeAccount finds them", () => {
    const src = readFileSync("src/lib/privacy-export.ts", "utf8");
    const body = src.slice(src.indexOf("export async function buildExport"));
    expect(body).toMatch(/const owner = acct\(u\);/);
    expect(body).not.toMatch(/const owner = u\.email;/);
  });
});
