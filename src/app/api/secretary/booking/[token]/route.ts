import { BOOK_PROVIDERS, BOOK_TOKEN, bookingKey, hashBookToken, resolveBook, type BookRecord } from "@/lib/booking-token";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { loginHolds } from "@/lib/secretary-feed";
import { applyBooking, parseCalcom, parseCalendly, verifyCalcomSignature, verifyCalendlySignature } from "@/lib/secretary-booking";

/**
 * POST: one booking tool's webhook (Reem phase 3 B2a). No session: the random token in the path locates the link and the
 * provider's signature over the raw body proves the sender, so a leaked URL alone forges nothing (spec sections 3 and 7;
 * the second founder-approved URL-secret exception, `permissions.md`). In order: the body read with a 64 KB cap; the
 * token shape (no store read for a wrong one); the record (`resolveBook`), and on a miss only, a count of 1200 an hour per
 * client IP, answered with the same empty 404 over the limit or not (spec B2-R6 as amended: providers deliver every
 * customer's webhooks from a few shared addresses, so a stranger's misses must never refuse a live link); 120 an hour
 * per link; the record's shape; the validity check
 * (`loginHolds`: the login still active and the scope still one of its account's active brands); the signature, picked by
 * `rec.provider` and keyed by `bookingKey(hash)` (Cal.com `x-cal-signature-256`, Calendly `Calendly-Webhook-Signature`,
 * a header over 512 characters refused unread); the JSON (400 when malformed: the sender is authenticated); the parser;
 * `applyBooking`, which acts on `rec.scope` only.
 *
 * Every failure up to and including a bad or missing signature is the same empty 404, so a probe learns nothing, with
 * these named exceptions: the per-link 429 (it shows a holder of a live token that the record exists); a store failure
 * before the signature check (the counters, `resolveBook`, `loginHolds`) is 503; a record that is not well
 * formed is 500, on purpose, and is answered BEFORE the validity check and the signature (it exists only if a token was
 * minted); and an error deriving the signing key or running the check (`CONNECT_SECRET` unset in production) is 500.
 * After a good signature: malformed JSON is 400; handled, ignored or replayed is 200; a held lock or a store failure
 * inside `applyBooking` is 503 (a provider retries on 5xx). Never logs the token, body, signature or key. Writes only the
 * rate counters, and through `applyBooking` the item, its claim and its audit line.
 */
const MAX_BODY = 64 * 1024;
const MAX_SIGNATURE = 512;
const PER_IP_HOUR = 1200;
const PER_LINK_HOUR = 120;
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const answer = (status: number, extra: Record<string, string> = {}) => new Response(null, { status, headers: { ...HEADERS, ...extra } });
const notFound = () => answer(404);

/**
 * The raw body, or null past `max` bytes: refused by its declared length, else by counting while reading. The proxy has
 * already buffered the body by then (up to `proxyClientMaxBodySize`, next.config.ts, rule 774), so this bounds what the
 * route keeps and parses, not what the server reads.
 */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const wellFormed = (r: BookRecord) =>
  typeof r.login === "string" && !!r.login && typeof r.scope === "string" && !!r.scope && (BOOK_PROVIDERS as readonly string[]).includes(r.provider);

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const raw = await readCapped(req, MAX_BODY).catch(() => null);
  if (raw === null) return notFound();
  const { token } = await ctx.params;
  if (typeof token !== "string" || !BOOK_TOKEN.test(token)) return notFound();

  let rec: BookRecord;
  let hash: string;
  try {
    const found = await resolveBook(token);
    if (!found) {
      // A miss counts against the address; over the limit or not, it is the same empty 404. A live link never meets
      // this bucket: providers deliver every customer's webhooks from a few shared addresses.
      await allow(`book:ip:${clientIp(req)}`, PER_IP_HOUR, 3600);
      return notFound();
    }
    rec = found;
    hash = hashBookToken(token);
    if (!(await allow(`book:t:${hash}`, PER_LINK_HOUR, 3600))) return retryLater(null, 3600, HEADERS);
    if (!wellFormed(rec)) return answer(500);
    if (!(await loginHolds(rec))) return notFound();
  } catch (e) {
    console.error("booking webhook store failed", e instanceof Error ? e.name : "error");
    return answer(503);
  }

  const calcom = rec.provider === "calcom";
  const sig = req.headers.get(calcom ? "x-cal-signature-256" : "calendly-webhook-signature");
  if (!sig || sig.length > MAX_SIGNATURE) return notFound();
  let signed: boolean;
  try {
    const key = bookingKey(hash);
    signed = calcom ? verifyCalcomSignature(raw, sig, key) : verifyCalendlySignature(raw, sig, key, Date.now());
  } catch {
    return answer(500);
  }
  if (!signed) return notFound();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return answer(400);
  }
  const parsed = calcom ? parseCalcom(body) : parseCalendly(body);
  const result = await applyBooking(rec, parsed, hash);
  return answer(result === "busy" ? 503 : 200);
}
