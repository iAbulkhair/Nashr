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
 * Most bytes a reply from a provider at a fixed host may hold (rule 2250): Shopify, Salla, Zid, Meta, Meta Ads, X, an
 * OAuth token URL, Telegram, Brevo and Klaviyo. The host is not the owner's, but its answer is still not ours to trust
 * with the memory every workspace shares; the largest page asked for (250 Shopify products, 100 Meta insight rows) is
 * well under the store cap, so the two are one number.
 */
export const PROVIDER_REPLY_BYTES = STORE_REPLY_BYTES;

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

/**
 * The first `max` bytes of a response body as text, the rest never read (rule 2246): for pages and sitemaps of any site
 * a user names, where the start is what is used and a cut-off end is harmless. The stream is cancelled at the cap; a
 * character split by the cut becomes U+FFFD.
 */
export async function responsePrefix(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - total;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    total += Math.min(value.byteLength, room);
    if (total >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Most bytes read of one page or sitemap of a site a user names (rule 2246): the crawl keeps 600,000 characters of it. */
export const PAGE_PREFIX_BYTES = 2 * 1024 * 1024;
