import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageCsp, reportOnlyCsp, uploadOrigin } from "@/lib/csp";
import { s3Config, s3Storage, signUpload, storageBackend } from "@/lib/media/s3";
import { amzDate, postPolicy, presignQuery, sha256Hex, signRequest, signingKey, uriEncode, type SigV4Credentials } from "@/lib/media/sigv4";
import { storage } from "@/lib/media/storage";
import { LOGO_UPLOAD, newUploadName, planUpload } from "@/lib/upload";

/**
 * Rules 3613-3617: the S3-compatible storage backend. Off by default (the disk stays); SigV4 from node:crypto checked
 * against AWS's published examples; a direct upload granted as a POST policy (or a pinned PUT); the bucket's origin in the
 * report-only connect-src only when the switch is on; the adapter's requests path-style, no redirect, never overwriting,
 * names the store's own. No test here reaches a network: every fetch is a fake.
 */

/** Fake settings only: no real endpoint, bucket or key. */
const FAKE = { MEDIA_STORAGE: "s3", S3_ENDPOINT: "https://s3.test.example", S3_REGION: "us-east-1", S3_BUCKET: "thakeen-test", S3_ACCESS_KEY_ID: "AKIDTESTONLY", S3_SECRET_ACCESS_KEY: "fake-secret-for-tests-only" } as const;
const stubS3 = (extra: Record<string, string> = {}) => { for (const [k, v] of Object.entries({ ...FAKE, ...extra })) vi.stubEnv(k, v); };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("rule 3613: the switch, the disk by default", () => {
  it("is the disk unless MEDIA_STORAGE is exactly s3", () => {
    for (const v of [undefined, "", "disk", "S3x", "s3 bucket"]) expect(storageBackend({ MEDIA_STORAGE: v } as unknown as NodeJS.ProcessEnv)).toBe("disk");
    expect(storageBackend({ MEDIA_STORAGE: " S3 " } as unknown as NodeJS.ProcessEnv)).toBe("s3");
    expect(storage().name).not.toBe("s3");
    stubS3();
    expect(storage()).toBe(s3Storage);
  });

  it("needs every setting, a bare https origin, a valid bucket and region; the upload mode defaults to post", () => {
    const env = (o: Record<string, string>) => ({ ...FAKE, ...o }) as unknown as NodeJS.ProcessEnv;
    expect(s3Config(env({}))).toMatchObject({ origin: "https://s3.test.example", host: "s3.test.example", bucket: "thakeen-test", upload: "post", creds: { region: "us-east-1", service: "s3" } });
    for (const k of ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) expect(s3Config(env({ [k]: "" }))).toBeNull();
    for (const e of ["http://s3.test.example", "https://u:p@s3.test.example", "https://s3.test.example/path", "https://s3.test.example?x=1", "https://s3.test.example#f", "not a url"]) expect(s3Config(env({ S3_ENDPOINT: e }))).toBeNull();
    for (const b of ["UPPER", "a", "has_underscore", "-dash"]) expect(s3Config(env({ S3_BUCKET: b }))).toBeNull();
    expect(s3Config(env({ S3_REGION: "us east" }))).toBeNull();
    expect(s3Config(env({ S3_UPLOAD: "PUT" }))?.upload).toBe("put");
    expect(s3Config(env({ S3_UPLOAD: "off" }))?.upload).toBe("off");
    expect(s3Config(env({ S3_UPLOAD: "weird" }))?.upload).toBe("post");
  });

  it("not configured: the adapter says so and the probe answers no_store without a request", async () => {
    stubS3({ S3_BUCKET: "" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(s3Storage.configured()).toBe(false);
    expect(await s3Storage.probe()).toMatchObject({ status: "error:no_store" });
    expect(await s3Storage.head(newUploadName())).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("rule 3614: SigV4 with node:crypto, checked against AWS's published examples", () => {
  const s3 = (): SigV4Credentials => ({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3" });
  const date = new Date("2013-05-24T00:00:00Z");
  const host = "examplebucket.s3.amazonaws.com";
  const empty = sha256Hex("");

  it("GET an object with a range", () => {
    const r = signRequest({ method: "GET", path: "/test.txt", headers: { host, range: "bytes=0-9", "x-amz-content-sha256": empty, "x-amz-date": amzDate(date) }, payloadHash: empty, creds: s3(), date });
    expect(r.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(r.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("PUT an object whose name needs encoding", () => {
    const body = "Welcome to Amazon S3.";
    const hash = sha256Hex(body);
    const r = signRequest({ method: "PUT", path: "/test$file.text", headers: { host, date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-date": amzDate(date), "x-amz-storage-class": "REDUCED_REDUNDANCY", "x-amz-content-sha256": hash }, payloadHash: hash, creds: s3(), date });
    expect(r.signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    expect(r.canonicalRequest.split("\n")[1]).toBe("/test%24file.text");
  });

  it("GET a bucket's sub-resource and a list with a query", () => {
    const headers = { host, "x-amz-content-sha256": empty, "x-amz-date": amzDate(date) };
    expect(signRequest({ method: "GET", path: "/", query: [["lifecycle", ""]], headers, payloadHash: empty, creds: s3(), date }).signature).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
    expect(signRequest({ method: "GET", path: "/", query: [["prefix", "J"], ["max-keys", "2"]], headers, payloadHash: empty, creds: s3(), date }).signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("a presigned GET URL", () => {
    const q = presignQuery({ method: "GET", path: "/test.txt", host, creds: s3(), date, expiresS: 86400 });
    expect(q.at(-1)).toEqual(["X-Amz-Signature", "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"]);
    expect(Object.fromEntries(q)).toMatchObject({ "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request", "X-Amz-Date": "20130524T000000Z", "X-Amz-Expires": "86400", "X-Amz-SignedHeaders": "host" });
  });

  it("the SigV4 test suite's get-vanilla, another service and region", () => {
    const d = new Date("2015-08-30T12:36:00Z");
    const r = signRequest({ method: "GET", path: "/", headers: { host: "example.amazonaws.com", "x-amz-date": amzDate(d) }, payloadHash: empty, creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service" }, date: d });
    expect(r.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("encodes as RFC 3986 wants, and the signing key is an HMAC chain (32 bytes), never the secret", () => {
    expect(uriEncode("a b/c~_.-ü")).toBe("a%20b%2Fc~_.-%C3%BC");
    expect(uriEncode("/a b/c", true)).toBe("/a%20b/c");
    const k = signingKey("secret", "20130524", "us-east-1", "s3");
    expect(k).toHaveLength(32);
    expect(k.toString("utf8")).not.toContain("secret");
  });

  it("the signer reads no environment, clock or network, and logs nothing", () => {
    const src = readFileSync("src/lib/media/sigv4.ts", "utf8");
    for (const bad of ["process.env", "Date.now", "new Date()", "fetch(", "console.", "log."]) expect(src).not.toContain(bad);
  });
});

describe("rule 3615: a direct upload is a POST policy (or a pinned PUT), never wider than the policy", () => {
  const c = () => s3Config({ ...FAKE } as unknown as NodeJS.ProcessEnv)!;
  const now = new Date("2026-10-23T10:00:00Z");
  const spec = (o: Record<string, unknown> = {}) => ({ name: newUploadName(), contentTypes: ["image/png"], maxBytes: 5000, expiresInS: 900, size: 1000, ...o });

  it("POST (default): the policy pins bucket, exact key, exact type, 1..maxBytes and the expiry", () => {
    const s = spec();
    const g = signUpload(c(), s, now);
    expect(g).toMatchObject({ url: "https://s3.test.example/thakeen-test", method: "POST", headers: {}, expiresAt: "2026-10-23T10:15:00.000Z" });
    expect(g.fields).toMatchObject({ key: s.name, "Content-Type": "image/png", "x-amz-algorithm": "AWS4-HMAC-SHA256", "x-amz-date": "20261023T100000Z" });
    const policy = JSON.parse(Buffer.from(g.fields!.policy, "base64").toString("utf8"));
    expect(policy.expiration).toBe("2026-10-23T10:15:00.000Z");
    expect(policy.conditions).toEqual(expect.arrayContaining([{ bucket: "thakeen-test" }, ["eq", "$key", s.name], ["eq", "$Content-Type", "image/png"], ["content-length-range", 1, 5000]]));
    // The secret is never in what the browser gets.
    expect(JSON.stringify(g)).not.toContain(FAKE.S3_SECRET_ACCESS_KEY);
    // The same inputs, the same policy: postPolicy is pure.
    const again = postPolicy({ bucket: "thakeen-test", key: s.name, contentType: "image/png", maxBytes: 5000, expiresAt: new Date(g.expiresAt), creds: c().creds, date: now });
    expect(again.fields["x-amz-signature"]).toBe(g.fields!["x-amz-signature"]);
  });

  it("PUT: signs the exact declared length and type with host, path-style, the URL's lifetime clamped", () => {
    const put = s3Config({ ...FAKE, S3_UPLOAD: "put" } as unknown as NodeJS.ProcessEnv)!;
    const s = spec({ expiresInS: 99999 });
    const g = signUpload(put, s, now);
    const u = new URL(g.url);
    expect([g.method, u.origin, u.pathname]).toEqual(["PUT", "https://s3.test.example", `/thakeen-test/${s.name}`]);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(g.headers).toEqual({ "content-type": "image/png" });
    expect(g.url).not.toContain(FAKE.S3_SECRET_ACCESS_KEY);
    expect(() => signUpload(put, spec({ size: undefined }), now)).toThrow("put_needs_size");
    expect(() => signUpload(put, spec({ size: 5001 }), now)).toThrow("put_needs_size");
    expect(signUpload(c(), spec({ expiresInS: 1 }), now).expiresAt).toBe("2026-10-23T10:01:00.000Z");
  });

  it("refuses direct upload off, a name not the store's, several types and a bad cap", () => {
    const off = s3Config({ ...FAKE, S3_UPLOAD: "off" } as unknown as NodeJS.ProcessEnv)!;
    expect(() => signUpload(off, spec(), now)).toThrow("direct_upload_off");
    expect(() => signUpload(c(), spec({ name: "../x.jpg" }), now)).toThrow("storage_name_refused");
    expect(() => signUpload(c(), spec({ contentTypes: ["image/png", "image/jpeg"] }), now)).toThrow("one_content_type");
    expect(() => signUpload(c(), spec({ maxBytes: 0 }), now)).toThrow("bad_cap");
  });

  it("through the planner: a signed plan with a server-made name; switched off it falls back to the server upload", async () => {
    stubS3();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await planUpload("w:a_s3test", LOGO_UPLOAD, { contentType: "image/png", size: 1000 });
    expect(r).toMatchObject({ ok: true, plan: { mode: "signed", method: "POST", url: "https://s3.test.example/thakeen-test", maxBytes: LOGO_UPLOAD.maxBytes } });
    stubS3({ S3_UPLOAD: "off" });
    expect(await planUpload("w:a_s3test", LOGO_UPLOAD, { contentType: "image/png", size: 1000 })).toMatchObject({ ok: true, plan: { mode: "server" } });
    // Planning signs locally: no request leaves.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("rule 3616: the bucket's origin in the report-only connect-src, only when the switch is on", () => {
  it("adds nothing on the disk, with direct upload off, or with a malformed endpoint", () => {
    expect(uploadOrigin({})).toBeNull();
    expect(uploadOrigin({ ...FAKE, MEDIA_STORAGE: "disk" })).toBeNull();
    expect(uploadOrigin({ ...FAKE, S3_UPLOAD: "off" })).toBeNull();
    for (const e of ["http://s3.test.example", "https://s3.test.example/x", "nope"]) expect(uploadOrigin({ ...FAKE, S3_ENDPOINT: e })).toBeNull();
    expect(uploadOrigin({ ...FAKE })).toBe("https://s3.test.example");
  });

  it("the report-only policy gets it, the enforced one has no connect-src at all", () => {
    const ro = reportOnlyCsp("bm9uY2U=", false, "https://s3.test.example");
    expect(ro).toMatch(/connect-src [^;]*https:\/\/s3\.test\.example/);
    expect(reportOnlyCsp("bm9uY2U=", false)).not.toContain("s3.test.example");
    expect(pageCsp("bm9uY2U=", false)).not.toContain("connect-src");
    expect(readFileSync("src/proxy.ts", "utf8")).toContain("reportOnlyCsp(nonce, dev, uploadOrigin())");
  });
});

describe("rule 3617: the adapter's requests", () => {
  type Call = { url: string; init: RequestInit };
  function fakeBucket(answer: (c: Call) => Response) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { const c = { url, init }; calls.push(c); return answer(c); }));
    return calls;
  }
  const hdr = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

  it("put: path-style, signed, no redirect, never overwriting; a 412 is storage_exists", async () => {
    stubS3();
    const name = newUploadName();
    const calls = fakeBucket(() => new Response(null, { status: 200 }));
    await s3Storage.put(name, Buffer.from("jpegbytes"));
    expect(calls[0].url).toBe(`https://s3.test.example/thakeen-test/${name}`);
    expect(calls[0].init).toMatchObject({ method: "PUT", redirect: "error" });
    expect(hdr(calls[0], "if-none-match")).toBe("*");
    expect(hdr(calls[0], "content-type")).toBe("image/jpeg");
    expect(hdr(calls[0], "x-amz-content-sha256")).toBe(sha256Hex("jpegbytes"));
    expect(hdr(calls[0], "authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTESTONLY\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
    expect(JSON.stringify(calls)).not.toContain(FAKE.S3_SECRET_ACCESS_KEY);
    fakeBucket(() => new Response(null, { status: 412 }));
    await expect(s3Storage.put(name, Buffer.from("x"))).rejects.toThrow("storage_exists");
  });

  it("get, head and stream; a 404 is nothing; a range is passed on", async () => {
    stubS3();
    const name = newUploadName();
    fakeBucket((c) => (c.init.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "9", "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" } }) : new Response("jpegbytes", { status: 200 })));
    expect((await s3Storage.get(name))?.toString()).toBe("jpegbytes");
    expect(await s3Storage.head(name)).toEqual({ size: 9, mtime: new Date("2026-10-21T07:28:00Z"), contentType: "image/jpeg" });
    const calls = fakeBucket(() => new Response("pegb", { status: 206 }));
    const chunks: Buffer[] = [];
    for await (const ch of s3Storage.stream(name, { start: 1, end: 4 })) chunks.push(ch as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("pegb");
    expect(hdr(calls[0], "range")).toBe("bytes=1-4");
    fakeBucket(() => new Response(null, { status: 404 }));
    expect(await s3Storage.get(name)).toBeNull();
    expect(await s3Storage.head(name)).toBeNull();
  });

  it("delete: HEAD first, so a key that never existed is missing; an existing one is deleted", async () => {
    stubS3();
    const name = newUploadName();
    const missing = fakeBucket(() => new Response(null, { status: 404 }));
    expect(await s3Storage.delete(name)).toBe("missing");
    expect(missing.map((c) => c.init.method)).toEqual(["HEAD"]);
    const there = fakeBucket((c) => new Response(null, { status: c.init.method === "HEAD" ? 200 : 204, headers: { "content-length": "1" } }));
    expect(await s3Storage.delete(name)).toBe("deleted");
    expect(there.map((c) => c.init.method)).toEqual(["HEAD", "DELETE"]);
  });

  it("a name that is not the store's is never requested", async () => {
    stubS3();
    const calls = fakeBucket(() => new Response("x"));
    for (const n of ["../etc/passwd", "a.jpg", "x/../../y.jpg", `${"a".repeat(32)}.html`]) {
      await expect(s3Storage.put(n, Buffer.from("x"))).rejects.toThrow();
      expect(await s3Storage.get(n)).toBeNull();
      expect(await s3Storage.head(n)).toBeNull();
      expect(await s3Storage.delete(n)).toBe("missing");
      expect(() => s3Storage.stream(n)).toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it("the probe writes, reads back and deletes its own object, never a store name", async () => {
    stubS3();
    let stored = "";
    const calls = fakeBucket((c) => {
      if (c.init.method === "PUT") { stored = Buffer.from(c.init.body as Uint8Array).toString(); return new Response(null, { status: 200 }); }
      if (c.init.method === "GET") return new Response(stored, { status: 200 });
      return new Response(null, { status: 204 });
    });
    expect(await s3Storage.probe()).toEqual({ status: "ok", survivedBuilds: null, freeBytes: null });
    expect(calls.map((c) => c.init.method)).toEqual(["PUT", "GET", "DELETE"]);
    expect(new Set(calls.map((c) => c.url)).size).toBe(1);
    expect(calls[0].url).toMatch(/\/thakeen-test\/probe-[a-f0-9]{16}\.txt$/);
    fakeBucket(() => { throw new Error("down"); });
    expect((await s3Storage.probe()).status).toBe("error:write_failed");
  });

  it("serves through our own routes, has no public bucket URL, and logs nothing", () => {
    expect(s3Storage.url(`${"a".repeat(32)}.jpg`)).toMatch(/\/m\/a{32}\.jpg$/);
    expect(s3Storage.url(`${"a".repeat(32)}.jpg`)).not.toContain("s3.test.example");
    const src = readFileSync("src/lib/media/s3.ts", "utf8");
    for (const bad of ["console.", "log.", "logError", "node:fs"]) expect(src).not.toContain(bad);
  });
});
