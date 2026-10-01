import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readImportStream } from "@/components/app/catalogImport";

/**
 * The Files page's catalog import reads /api/catalog's event stream (#43). A connection dropped mid-stream made
 * `reader.read()` throw out of the handler, so "Reading sitemap and product pages…" stayed on screen and the button
 * stayed disabled. Rule 377 in docs/system/tests.md.
 */
const enc = new TextEncoder();
/** A body that sends these chunks, then either ends or fails the next read the way a dropped connection does. */
function body(chunks: string[], then: "end" | "drop" = "end") {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else if (then === "drop") c.error(new TypeError("network error"));
      else c.close();
    },
  });
}
const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;

describe("a catalog import always ends with a result (rule 377)", () => {
  it("a done event with products is a success, and progress lines are passed on", async () => {
    const seen: string[] = [];
    const end = await readImportStream(body([ev({ progress: "3/10" }), ev({ progress: "10/10" }) + ev({ done: true, count: 7 })]), (p) => seen.push(p));
    expect(end).toEqual({ ok: true, count: 7 });
    expect(seen).toEqual(["3/10", "10/10"]);
  });

  it("an event split across chunks, or the last one without its blank line, still counts", async () => {
    expect(await readImportStream(body(['data: {"done":tr', 'ue,"count":2}']), () => {})).toEqual({ ok: true, count: 2 });
  });

  it("a connection dropped mid-stream is a failure, not a throw", async () => {
    await expect(readImportStream(body([ev({ progress: "1/10" })], "drop"), () => {})).resolves.toEqual({ ok: false });
  });

  it("an error event, a done with no products, or a stream that ends with no result is a failure", async () => {
    expect(await readImportStream(body([ev({ error: "no_pages" })]), () => {})).toEqual({ ok: false });
    expect(await readImportStream(body([ev({ done: true, count: 0 })]), () => {})).toEqual({ ok: false });
    expect(await readImportStream(body([ev({ progress: "1/10" })]), () => {})).toEqual({ ok: false });
  });

  it("FilesPanel clears the busy state in a finally and opens products.md only after a successful import", () => {
    const src = readFileSync("src/components/app/FilesPanel.tsx", "utf8");
    const fn = src.slice(src.indexOf("async function importCatalog"), src.indexOf("async function save("));
    expect(fn).toContain("readImportStream(");
    expect(fn).toMatch(/finally \{\s*setImporting\(false\);/);
    expect(fn.match(/setImporting\(false\)/g), "only in the finally").toHaveLength(1);
    expect(fn).toMatch(/if \(end\.ok\) \{\s*setOpen\("products\.md"\)/);
  });
});
