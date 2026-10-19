import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { STORE_REPLY_BYTES, TooLargeError, responseBytes, responseJson } from "@/lib/read-capped";
import { importWoo } from "@/lib/connectors/woocommerce";
import { importOdoo } from "@/lib/connectors/keyed";
import { readFile } from "@/lib/files";
import type { Connection } from "@/lib/connectors/store";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rule 2245 (docs/system/tests/2240-key-check-rate.md): a reply from a host the owner typed in (WooCommerce, Odoo,
 * PrestaShop, WordPress) is read through `responseBytes`, which stops at a byte cap whatever `content-length` says, so
 * one broken or hostile store cannot fill the memory every workspace on the instance shares.
 */

const MB = 1024 * 1024;
/** A body that never ends, without a content-length; counts how many 1 MB chunks were pulled. */
function endless() {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      seen.pulls++;
      ctl.enqueue(new Uint8Array(MB).fill(0x20));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { res: new Response(body, { headers: { "content-type": "application/json" } }), seen };
}

afterEach(() => vi.unstubAllGlobals());

describe("replies from owner-supplied hosts are read up to a cap (rule 2245)", () => {
  it("a body under the cap is read whole; a body that parses badly throws SyntaxError as res.json() does", async () => {
    expect((await responseBytes(new Response("hello"), 10)).toString()).toBe("hello");
    expect(await responseJson(Response.json({ a: 1 }), 100)).toEqual({ a: 1 });
    await expect(responseJson(new Response("{nope"), 100)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("a declared length over the cap is refused before a byte is read", async () => {
    const { res, seen } = endless();
    const big = new Response(res.body, { headers: { "content-length": String(20 * MB) } });
    await expect(responseBytes(big, 8 * MB)).rejects.toBeInstanceOf(TooLargeError);
    expect(seen.pulls).toBeLessThanOrEqual(1);
  });

  it("an endless body without a length stops just past the cap and the stream is cancelled", async () => {
    const { res, seen } = endless();
    await expect(responseBytes(res, 3 * MB)).rejects.toThrow("too_large");
    expect(seen.pulls).toBeLessThanOrEqual(5);
    expect(seen.cancelled).toBe(true);
  });

  it("a WooCommerce or Odoo host that answers without end fails the import and leaves products.md alone", async () => {
    const ws = await newUser("replycap").then((u) => u.email);
    const streams: ReturnType<typeof endless>["seen"][] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = endless();
      streams.push(e.seen);
      return e.res;
    }));
    const woo: Connection = { provider: "woocommerce", data: { site: "https://shop.example", consumerKey: "ck", consumerSecret: "cs" }, connectedAt: new Date().toISOString() };
    await expect(importWoo(ws, woo)).rejects.toThrow("too_large");
    const odoo: Connection = { provider: "odoo", data: { url: "https://erp.example", db: "d", username: "u", apiKey: "k" }, connectedAt: new Date().toISOString() };
    await expect(importOdoo(ws, odoo)).rejects.toThrow("too_large");
    expect(await readFile(ws, "products.md")).toBeNull();
    for (const s of streams) expect(s.pulls).toBeLessThanOrEqual(STORE_REPLY_BYTES / MB + 2);
  });

  it("no reply of an owner-supplied host is read with res.json(), res.text() or arrayBuffer()", () => {
    const code = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const all = code("src/lib/connectors/keyed.ts");
    // Odoo and PrestaShop only: Telegram, Brevo and Klaviyo are fixed hosts.
    const keyed = all.slice(all.indexOf("async function odooCall"), all.indexOf("export async function verifyTelegram"));
    expect(keyed.length).toBeGreaterThan(500);
    const userHosts = [code("src/lib/connectors/woocommerce.ts"), code("src/lib/connectors/wordpress.ts"), keyed];
    for (const src of userHosts) expect(src).not.toMatch(/\.(?:json|text|arrayBuffer|blob)\(\)/);
    expect(keyed.match(/responseJson\(/g)).toHaveLength(3);
    expect(STORE_REPLY_BYTES).toBe(8 * MB);
  });
});
