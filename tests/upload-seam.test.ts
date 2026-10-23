import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { MEDIA_NAME } from "@/lib/media-catalog";
import { storage, type SignedUploadSpec, type StorageAdapter } from "@/lib/media/storage";
import { AVATAR_UPLOAD, checkBytes, checkDeclared, newUploadName, planUpload, readCappedBody, takeUpload, type UploadPolicy } from "@/lib/upload";

/**
 * Rules 3500-3501: the signed upload seam. A backend that can sign gets the server's name and the policy's limits as
 * parameters; one that cannot (the disk) or whose signing throws answers the server upload. A finished signed upload is
 * found only under the caller's own owner, once, and its bytes are checked by magic number, not by the declared type.
 */

const png = (w = 8, h = 8) => sharp({ create: { width: w, height: h, channels: 3, background: "#336699" } }).png().toBuffer();

/** A bucket-like backend in memory: it signs, records every spec it was asked to sign, and keeps what the "browser" put. */
function signingStore(opts: { throws?: boolean; configured?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const specs: SignedUploadSpec[] = [];
  const st: StorageAdapter & { files: Map<string, Buffer>; specs: SignedUploadSpec[] } = {
    name: "fake-bucket",
    files,
    specs,
    async signedUpload(spec) {
      specs.push(spec);
      if (opts.throws) throw new Error("signing down");
      return { url: `https://bucket.example/${spec.name}?sig=x`, method: "PUT", headers: { "content-type": spec.contentTypes[0] }, expiresAt: new Date(Date.now() + spec.expiresInS * 1000).toISOString() };
    },
    configured: () => opts.configured ?? true,
    async put(name, body) { files.set(name, body); },
    async get(name) { return files.get(name) ?? null; },
    stream: (name) => Readable.from(files.get(name) ?? Buffer.alloc(0)),
    async head(name) { const b = files.get(name); return b ? { size: b.length, mtime: new Date(), contentType: "image/jpeg" } : null; },
    async delete(name) { return files.delete(name) ? "deleted" : "missing"; },
    url: (name) => `https://x.example/m/${name}`,
    freeBytes: async () => Infinity,
    probe: async () => ({ ok: true, freeBytes: null }) as never,
  };
  return st;
}

describe("rule 3500: the storage seam is provider-neutral", () => {
  it("the disk backend has no signer, so the planner answers the server upload with the policy's limits", async () => {
    expect(storage().signedUpload).toBeUndefined();
    const r = await planUpload("p:p_disk", AVATAR_UPLOAD, { contentType: "image/png", size: 1000 });
    expect(r).toEqual({ ok: true, plan: { mode: "server", maxBytes: AVATAR_UPLOAD.maxBytes, contentTypes: AVATAR_UPLOAD.contentTypes } });
  });

  it("a signing backend gets a server-made name and the limits as parameters, never a name from the request", async () => {
    const st = signingStore();
    const policy: UploadPolicy = { kind: "logo", contentTypes: ["image/png"], formats: ["png"], maxBytes: 1234, ttlS: 60 };
    const r = await planUpload("s:owner@x.example", policy, { contentType: "IMAGE/PNG", size: 1000, ...({ name: "../../evil.jpg" } as object) }, st);
    expect(r.ok).toBe(true);
    if (!r.ok || r.plan.mode !== "signed") throw new Error("expected a signed plan");
    expect(r.plan.name).toMatch(MEDIA_NAME);
    expect(r.plan.name).not.toContain("evil");
    expect(st.specs).toEqual([{ name: r.plan.name, contentTypes: ["image/png"], maxBytes: 1234, expiresInS: 60 }]);
    expect(r.plan.maxBytes).toBe(1234);
    expect(await db.get(globalKey.uploadTicket("s:owner@x.example", r.plan.name))).toMatchObject({ kind: "logo", maxBytes: 1234 });
  });

  it("a backend not configured, or a signing that throws, falls back to the server upload and stores no ticket", async () => {
    for (const st of [signingStore({ configured: false }), signingStore({ throws: true })]) {
      const r = await planUpload("p:p_fb", AVATAR_UPLOAD, { contentType: "image/jpeg", size: 10 }, st);
      expect(r).toMatchObject({ ok: true, plan: { mode: "server" } });
    }
  });

  it("names are 128 random bits in the store's shape", () => {
    const a = newUploadName();
    expect(a).toMatch(/^[a-f0-9]{32}\.jpg$/);
    expect(a).toMatch(MEDIA_NAME);
    expect(newUploadName()).not.toBe(a);
  });
});

describe("rule 3501: declared limits, then the bytes, then a ticket used once under its owner", () => {
  it("refuses a wrong type, a size over the cap and a malformed input before any grant", async () => {
    const st = signingStore();
    expect(await planUpload("p:x", AVATAR_UPLOAD, { contentType: "image/svg+xml", size: 10 }, st)).toEqual({ ok: false, error: "bad_type" });
    expect(await planUpload("p:x", AVATAR_UPLOAD, { contentType: "image/png", size: AVATAR_UPLOAD.maxBytes + 1 }, st)).toEqual({ ok: false, error: "too_large" });
    for (const size of [0, -1, 1.5, "10", undefined]) expect(checkDeclared(AVATAR_UPLOAD, "image/png", size)).toBe("bad_input");
    expect(checkDeclared(AVATAR_UPLOAD, 5, 10)).toBe("bad_input");
    expect(st.specs).toHaveLength(0);
  });

  it("judges the bytes by magic number: HTML declared as PNG is refused", async () => {
    expect(checkBytes(AVATAR_UPLOAD, await png())).toBeNull();
    expect(checkBytes(AVATAR_UPLOAD, Buffer.from("<!doctype html><svg onload=alert(1)>"))).toBe("bad_type");
    expect(checkBytes(AVATAR_UPLOAD, Buffer.alloc(0))).toBe("bad_input");
    expect(checkBytes({ ...AVATAR_UPLOAD, maxBytes: 10 }, await png())).toBe("too_large");
  });

  it("takes a finished upload under its own owner only, once, and deletes the raw object", async () => {
    const st = signingStore();
    const r = await planUpload("p:p_alice", AVATAR_UPLOAD, { contentType: "image/png", size: 100 }, st);
    if (!r.ok || r.plan.mode !== "signed") throw new Error("expected a signed plan");
    st.files.set(r.plan.name, await png());
    // Another person names Alice's object: nothing, and Alice's ticket is untouched.
    expect(await takeUpload("p:p_mallory", AVATAR_UPLOAD, r.plan.name, st)).toEqual({ ok: false, error: "not_found" });
    const got = await takeUpload("p:p_alice", AVATAR_UPLOAD, r.plan.name, st);
    expect(got.ok).toBe(true);
    expect(st.files.has(r.plan.name)).toBe(false);
    expect(await takeUpload("p:p_alice", AVATAR_UPLOAD, r.plan.name, st)).toEqual({ ok: false, error: "not_found" });
  });

  it("a made-up or malformed name, a ticket of another kind, and bytes that are not an image are refused", async () => {
    const st = signingStore();
    for (const n of ["../x.jpg", "abc.jpg", 42, null]) expect(await takeUpload("p:p_b", AVATAR_UPLOAD, n, st)).toEqual({ ok: false, error: "not_found" });
    const logo: UploadPolicy = { ...AVATAR_UPLOAD, kind: "logo" };
    const r = await planUpload("p:p_b", logo, { contentType: "image/png", size: 10 }, st);
    if (!r.ok || r.plan.mode !== "signed") throw new Error("expected a signed plan");
    st.files.set(r.plan.name, await png());
    expect(await takeUpload("p:p_b", AVATAR_UPLOAD, r.plan.name, st)).toEqual({ ok: false, error: "not_found" });
    const r2 = await planUpload("p:p_b", AVATAR_UPLOAD, { contentType: "image/png", size: 10 }, st);
    if (!r2.ok || r2.plan.mode !== "signed") throw new Error("expected a signed plan");
    st.files.set(r2.plan.name, Buffer.from("<html>not an image</html>"));
    expect(await takeUpload("p:p_b", AVATAR_UPLOAD, r2.plan.name, st)).toEqual({ ok: false, error: "bad_type" });
  });

  it("reads a server upload with a running cap, whatever Content-Length says", async () => {
    const big = new Request("https://nashr.test/x", { method: "POST", body: new Uint8Array(50) });
    expect(await readCappedBody(big, 10)).toBe("too_large");
    const lying = new Request("https://nashr.test/x", { method: "POST", headers: { "content-length": "999999999" }, body: new Uint8Array(5) });
    expect(await readCappedBody(lying, 10)).toBe("too_large");
    const ok = await readCappedBody(new Request("https://nashr.test/x", { method: "POST", body: new Uint8Array([1, 2, 3]) }), 10);
    expect(Buffer.isBuffer(ok) && ok.length).toBe(3);
    expect(await readCappedBody(new Request("https://nashr.test/x", { method: "POST" }), 10)).toBeNull();
  });

  it("logs no owner, name or URL when signing fails", async () => {
    const { log } = await import("@/lib/log");
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    await planUpload("p:p_secret", AVATAR_UPLOAD, { contentType: "image/png", size: 10 }, signingStore({ throws: true }));
    const text = JSON.stringify(spy.mock.calls);
    expect(text).not.toContain("p_secret");
    expect(text).not.toContain("bucket.example");
    spy.mockRestore();
  });

  it("the source keeps the owner out of the request: routes build it from the session's person", () => {
    for (const f of ["src/app/api/account/avatar/route.ts", "src/app/api/account/avatar/upload/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toContain("personKey.uploadOwner(me.pid)");
      expect(src).toContain("actingLogin(u)");
    }
  });
});
