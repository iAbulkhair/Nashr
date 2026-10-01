/** How one catalog import ended: the products saved, or a failure to report with `importFail`. */
export type ImportEnd = { ok: true; count: number } | { ok: false };

/**
 * Read the /api/catalog event stream (`data: {...}` events) to its end; `onProgress` gets each progress line. Only a
 * `done` event with products is a success. A connection dropped mid-stream (a `read()` that throws), an `error` event,
 * a `done` with no products, or a stream that ends without `done` or `error` is a failure: it is never left on screen as
 * an import still "Reading…", with the button disabled (#43). Never throws.
 */
export async function readImportStream(body: ReadableStream<Uint8Array>, onProgress: (progress: string) => void): Promise<ImportEnd> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let end: ImportEnd | null = null;
  let failed = false;
  const take = (part: string) => {
    try {
      const j = JSON.parse(part.trim().replace(/^data: /, "")) as { progress?: string; done?: boolean; count?: number; error?: unknown };
      if (j.progress) onProgress(String(j.progress));
      if (j.done) end = typeof j.count === "number" && j.count > 0 ? { ok: true, count: j.count } : { ok: false };
      if (j.error) failed = true;
    } catch {}
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      parts.forEach(take);
    }
    buf += dec.decode();
    if (buf.trim()) take(buf);
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false };
  }
  return failed ? { ok: false } : (end ?? { ok: false });
}
