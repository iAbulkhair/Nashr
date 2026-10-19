/**
 * A request body as text, or null past `max` bytes: the declared length first, then a running total, so a lying header
 * cannot get more read. For public callbacks whose bodies are small by nature (src/app/api/billing/paymob/webhook).
 */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A reply larger than the caller allows (rule 2245). */
export class TooLargeError extends Error {
  constructor() {
    super("too_large");
    this.name = "TooLargeError";
  }
}

/**
 * Most bytes a reply from a host the owner typed in (their WooCommerce, Odoo, PrestaShop or WordPress site) may hold
 * (rule 2245). Fifty products or a hundred orders with every field are well under a megabyte; past this the host is
 * broken or hostile, and buffering it would take the memory every workspace on the instance shares.
 */
export const STORE_REPLY_BYTES = 8 * 1024 * 1024;

/**
 * A response body as bytes, or TooLargeError past `max`: the declared length first, then a running total, so a lying
 * or missing `content-length` cannot get more read (rule 2245). The stream is cancelled at the cap.
 */
export async function responseBytes(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    throw new TooLargeError();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `res.text()` with the cap of `responseBytes`. */
export const responseText = async (res: Response, max: number) => (await responseBytes(res, max)).toString("utf8");

/** `res.json()` with the cap of `responseBytes`: a body that does not parse throws SyntaxError, as `res.json()` does. */
export const responseJson = async <T = unknown>(res: Response, max: number): Promise<T> => JSON.parse(await responseText(res, max)) as T;
