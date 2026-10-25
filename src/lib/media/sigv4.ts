/**
 * AWS Signature Version 4 with node:crypto only (rule 3614): no SDK, no dependency. Pure functions: nothing here reads the
 * environment, the network or a clock (the caller passes the date), so tests/s3-storage.test.ts checks every one against
 * AWS's published examples. Used by the S3-compatible storage adapter (src/lib/media/s3.ts).
 *
 * Nothing here logs. A secret only ever goes into an HMAC key; the returned values (an Authorization header, a signature,
 * a policy) are what a request carries anyway, and the adapter never logs those either.
 */
import { createHash, createHmac } from "node:crypto";

export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string; region: string; service: string };

export const ALGORITHM = "AWS4-HMAC-SHA256";
/** The body hash S3 accepts in a presigned URL, where the body is not known when the URL is made. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** `20130524T000000Z`: the ISO-8601 basic form SigV4 signs. */
export const amzDate = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The derived signing key for one day, region and service: HMAC chain from `AWS4` + the secret. */
export function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

/** `{day}/{region}/{service}/aws4_request`. */
export const credentialScope = (day: string, c: Pick<SigV4Credentials, "region" | "service">) => `${day}/${c.region}/${c.service}/aws4_request`;

/**
 * RFC 3986 encoding as SigV4 wants it: the unreserved characters `A-Z a-z 0-9 - . _ ~` stay, every other UTF-8 byte is
 * `%XX` in upper case; a `/` stays only in a path.
 */
export function uriEncode(s: string, keepSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    const unreserved = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
    if (unreserved || (keepSlash && byte === 0x2f)) out += String.fromCharCode(byte);
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The query in canonical form: each name and value encoded, sorted by name then value, `a=b&c=` (an empty value keeps `=`). */
export function canonicalQuery(query: readonly (readonly [string, string])[]): string {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Header names in lower case, values trimmed with inner runs of spaces made one, sorted by name. */
function canonicalHeaders(headers: Record<string, string>): { block: string; signed: string } {
  const rows = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { block: rows.map(([k, v]) => `${k}:${v}\n`).join(""), signed: rows.map(([k]) => k).join(";") };
}

export type SignInput = {
  method: string;
  /** The path as stored (not yet encoded): `/bucket/name`. Encoded once here, as S3 wants (no double encoding). */
  path: string;
  query?: readonly (readonly [string, string])[];
  /** Every header to sign, `host` and `x-amz-date` included (the caller sets them: `signedRequestHeaders` does). */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  creds: SigV4Credentials;
  date: Date;
};

/** One request's signature, with the steps a test can compare with AWS's worked examples. */
export function signRequest(i: SignInput): { authorization: string; signature: string; canonicalRequest: string; stringToSign: string; signedHeaders: string } {
  const stamp = amzDate(i.date);
  const day = stamp.slice(0, 8);
  const { block, signed } = canonicalHeaders(i.headers);
  const canonicalRequest = [i.method.toUpperCase(), uriEncode(i.path || "/", true), canonicalQuery(i.query ?? []), block, signed, i.payloadHash].join("\n");
  const scope = credentialScope(day, i.creds);
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(i.creds.secretAccessKey, day, i.creds.region, i.creds.service)).update(stringToSign, "utf8").digest("hex");
  const authorization = `${ALGORITHM} Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return { authorization, signature, canonicalRequest, stringToSign, signedHeaders: signed };
}

/**
 * A presigned URL's query (query-string authentication): the signed headers (`host`, plus any the caller pins, such as
 * `content-length` and `content-type` for a PUT) must be sent exactly as signed, and the URL dies after `expiresS`.
 * Returns the query pairs to append, the signature last.
 */
export function presignQuery(i: { method: string; path: string; host: string; extraHeaders?: Record<string, string>; query?: readonly (readonly [string, string])[]; creds: SigV4Credentials; date: Date; expiresS: number }): [string, string][] {
  const stamp = amzDate(i.date);
  const headers = { host: i.host, ...(i.extraHeaders ?? {}) };
  const signedHeaders = Object.keys(headers).map((k) => k.toLowerCase()).sort().join(";");
  const query: [string, string][] = [
    ...(i.query ?? []).map(([k, v]) => [k, v] as [string, string]),
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${i.creds.accessKeyId}/${credentialScope(stamp.slice(0, 8), i.creds)}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(i.expiresS)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  const { signature } = signRequest({ method: i.method, path: i.path, query, headers, payloadHash: UNSIGNED_PAYLOAD, creds: i.creds, date: i.date });
  return [...query, ["X-Amz-Signature", signature]];
}

/** A query as the URL carries it (the same encoding as the canonical form, in the given order). */
export const queryString = (q: readonly (readonly [string, string])[]): string => q.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");

export type PostPolicyInput = {
  bucket: string;
  key: string;
  contentType: string;
  /** The body must be 1..maxBytes bytes: the bucket refuses anything else (`content-length-range`). */
  maxBytes: number;
  expiresAt: Date;
  creds: SigV4Credentials;
  date: Date;
};

/**
 * A browser POST upload's form fields (S3 POST policy, SigV4). The policy pins the bucket, the exact key, the exact
 * content type, the size range 1..maxBytes and the expiry; the bucket refuses a form that breaks any of them. The file
 * field goes last, after these fields. The policy text is returned too, so a test can read the limits back.
 */
export function postPolicy(i: PostPolicyInput): { fields: Record<string, string>; policy: { expiration: string; conditions: unknown[] } } {
  const stamp = amzDate(i.date);
  const credential = `${i.creds.accessKeyId}/${credentialScope(stamp.slice(0, 8), i.creds)}`;
  const policy = {
    expiration: i.expiresAt.toISOString(),
    conditions: [
      { bucket: i.bucket },
      ["eq", "$key", i.key],
      ["eq", "$Content-Type", i.contentType],
      ["content-length-range", 1, i.maxBytes],
      { "x-amz-algorithm": ALGORITHM },
      { "x-amz-credential": credential },
      { "x-amz-date": stamp },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(policy), "utf8").toString("base64");
  const signature = createHmac("sha256", signingKey(i.creds.secretAccessKey, stamp.slice(0, 8), i.creds.region, i.creds.service)).update(encoded, "utf8").digest("hex");
  return {
    fields: { key: i.key, "Content-Type": i.contentType, "x-amz-algorithm": ALGORITHM, "x-amz-credential": credential, "x-amz-date": stamp, policy: encoded, "x-amz-signature": signature },
    policy,
  };
}
