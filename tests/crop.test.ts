import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, NUDGE, OUT_PX, ZOOM_STEP, baseScale, clampState, drawRect, initialState, keyAction, nudge, zoomTo, type CropBox } from "@/lib/crop";
import { sendImage } from "@/lib/upload-client";

/**
 * Rules 3618-3620: the square crop dialog. Its arithmetic is pure (src/lib/crop.ts); the dialog draws on a canvas only,
 * is built on Dialog (focus trap, Escape), moves by the arrow keys and zooms by +/−, never mirrors in RTL, and hands a
 * JPEG Blob to the one shared upload client (src/lib/upload-client.ts), which the server checks again.
 */

const wide = (fit: CropBox["fit"]): CropBox => ({ w: 800, h: 400, view: 256, fit });

describe("rule 3618: the crop arithmetic", () => {
  it("cover fills the frame with the short side; contain fits the long side", () => {
    expect(baseScale(wide("cover"))).toBeCloseTo(256 / 400);
    expect(baseScale(wide("contain"))).toBeCloseTo(256 / 800);
    expect(baseScale({ w: 0, h: 10, view: 256, fit: "cover" })).toBe(1);
  });

  it("opens centred at zoom 1; cover leaves no empty band, contain keeps the whole image inside", () => {
    const c = initialState(wide("cover"));
    expect(c).toEqual({ x: (256 - 512) / 2, y: 0, zoom: 1 });
    const k = initialState(wide("contain"));
    expect(k).toEqual({ x: 0, y: (256 - 128) / 2, zoom: 1 });
  });

  it("moves stay in bounds on each axis", () => {
    const b = wide("cover");
    const s = initialState(b);
    expect(nudge(b, s, 1000, 0).x).toBe(0);
    expect(nudge(b, s, -1000, 0).x).toBe(256 - 512);
    expect(nudge(b, s, 0, 50).y).toBe(0);
    const c = wide("contain");
    expect(nudge(c, initialState(c), 0, 1000).y).toBe(256 - 128);
    expect(nudge(c, initialState(c), 0, -1000).y).toBe(0);
  });

  it("zoom is clamped to 1..4 and keeps the frame's centre point", () => {
    const b = wide("cover");
    const s = initialState(b);
    expect(zoomTo(b, s, 99).zoom).toBe(MAX_ZOOM);
    expect(zoomTo(b, s, 0).zoom).toBe(MIN_ZOOM);
    const z = zoomTo(b, s, 2);
    const k = baseScale(b) * 2;
    // The centre of the frame shows the image's centre before and after.
    expect((128 - z.x) / k).toBeCloseTo(400);
    expect((128 - z.y) / k).toBeCloseTo(200);
    expect(clampState(b, { x: Number.NaN, y: Number.NaN, zoom: Number.NaN }).zoom).toBe(1);
  });

  it("the output rectangle scales the frame onto the 512 px square", () => {
    const b = wide("contain");
    const s = initialState(b);
    expect(OUT_PX).toBe(512);
    expect(drawRect(b, s, OUT_PX)).toEqual({ dx: 0, dy: 128, dw: 512, dh: 256 });
  });

  it("keys: arrows move the way they point (Shift one pixel), + and − zoom, anything else is the dialog's", () => {
    expect(keyAction("ArrowLeft", false)).toEqual({ move: [-NUDGE, 0] });
    expect(keyAction("ArrowRight", true)).toEqual({ move: [1, 0] });
    expect(keyAction("ArrowUp", false)).toEqual({ move: [0, -NUDGE] });
    expect(keyAction("ArrowDown", false)).toEqual({ move: [0, NUDGE] });
    expect(keyAction("+", false)).toEqual({ zoom: ZOOM_STEP });
    expect(keyAction("=", false)).toEqual({ zoom: ZOOM_STEP });
    expect(keyAction("-", false)).toEqual({ zoom: -ZOOM_STEP });
    for (const k of ["Escape", "Tab", "Enter", "a"]) expect(keyAction(k, false)).toBeNull();
  });
});

describe("rule 3619: the dialog", () => {
  const src = readFileSync("src/components/ui/CropDialog.tsx", "utf8");

  it("is built on Dialog (focus trap, Escape) with a canvas, and hands back a JPEG Blob", () => {
    expect(src).toContain('import { Dialog } from "./Dialog"');
    expect(src).toContain("<Dialog");
    expect(src).toContain("<canvas");
    expect(src).toContain('toBlob(res, "image/jpeg"');
    expect(src).toContain("URL.revokeObjectURL(url)");
    expect(src).toContain("onKeyDown={onKey}");
    expect(src).toContain("keyAction(e.key, e.shiftKey)");
  });

  it("has its words in Arabic and English", () => {
    expect(src).toContain("اقتصاص الصورة");
    expect(src).toContain("Crop the image");
    expect(src).toMatch(/ar: \{[\s\S]*zoomIn:[\s\S]*en: \{[\s\S]*zoomIn:/);
  });

  it("is RTL-safe: logical classes only, the image never mirrored", () => {
    expect(src).not.toMatch(/\b(ml|mr|pl|pr|left|right)-\d/);
    expect(src).not.toMatch(/scaleX\(-1\)|scale-x-\[-1\]|-scale-x/);
  });

  it("imports no image library and nothing from the server", () => {
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./Button", "./Dialog", "@/lib/crop", "react"]);
    expect(readFileSync("src/lib/crop.ts", "utf8")).not.toMatch(/^import /m);
  });
});

describe("rule 3620: one upload client for the picture and the logo", () => {
  const blob = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: "image/jpeg" });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("signed POST: fields first, the file last, then the server-made name back to the route", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/account/logo/upload") return ok({ ok: true, mode: "signed", name: "n.jpg", url: "https://bucket.test/b", method: "POST", headers: {}, fields: { key: "n.jpg", policy: "p" } });
      if (url === "https://bucket.test/b") return new Response(null, { status: 204 });
      return ok({ ok: true, url: "/api/logo/n.jpg?s=x" });
    }) as unknown as typeof fetch;
    expect(await sendImage("/api/account/logo", blob(), f)).toEqual({ ok: true, url: "/api/logo/n.jpg?s=x" });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ contentType: "image/jpeg", size: 6 });
    const form = calls[1].init.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
    expect(calls[2]).toMatchObject({ url: "/api/account/logo", init: { method: "POST" } });
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ name: "n.jpg" });
  });

  it("signed PUT sends the blob itself; the server mode posts the image; a refusal is an error, never a throw", async () => {
    const seen: string[] = [];
    const put = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      if (url.endsWith("/upload")) return ok({ ok: true, mode: "signed", name: "n.jpg", url: "https://bucket.test/n.jpg?sig", method: "PUT", headers: { "content-type": "image/jpeg" } });
      if (url.startsWith("https://")) { expect(init.body).toBeInstanceOf(Blob); return new Response(null, { status: 200 }); }
      return ok({ ok: true, url: "/api/avatar/n.jpg?s=x" });
    }) as unknown as typeof fetch;
    expect(await sendImage("/api/account/avatar", blob(), put)).toMatchObject({ ok: true });
    expect(seen).toEqual(["POST /api/account/avatar/upload", "PUT https://bucket.test/n.jpg?sig", "POST /api/account/avatar"]);

    const server = vi.fn(async (url: string, init: RequestInit) => (url.endsWith("/upload") ? ok({ ok: true, mode: "server" }) : (expect(init.body).toBeInstanceOf(Blob), ok({ ok: true, url: "/u" })))) as unknown as typeof fetch;
    expect(await sendImage("/api/account/logo", blob(), server)).toEqual({ ok: true, url: "/u" });
    const refused = vi.fn(async () => ok({ ok: false, error: "forbidden" })) as unknown as typeof fetch;
    expect(await sendImage("/api/account/logo", blob(), refused)).toEqual({ ok: false, error: "forbidden" });
    const down = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await sendImage("/api/account/logo", blob(), down)).toEqual({ ok: false, error: "generic" });
  });

  it("the picture and the logo both crop first and upload through it", () => {
    const avatar = readFileSync("src/components/app/settings/AvatarUpload.tsx", "utf8");
    const logo = readFileSync("src/components/app/settings/LogoUpload.tsx", "utf8");
    for (const s of [avatar, logo]) {
      expect(s).toContain("<CropDialog");
      expect(s).toContain("sendImage(");
    }
    expect(avatar).toContain('fit="cover"');
    expect(logo).toContain('fit="contain"');
    expect(readFileSync("src/lib/upload-client.ts", "utf8")).not.toMatch(/^import /m);
  });
});
