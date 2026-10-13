import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import jsQR from "jsqr";
import { encode } from "uqr";
import { QR_QUIET, qrPath } from "@/lib/qr";
import { newTotpSecret, otpauthUri } from "@/lib/totp";
import QrCode from "@/components/admin/QrCode";
import { SF } from "@/components/admin/SecondFactor";

/**
 * The QR code in the founder console's two-step setup: rules 1620-1624 in docs/system/tests/1620-admin-2fa-qr.md.
 * The code is drawn from the otpauth URI on the page itself, so these tests rasterise the exact path the dialog draws and
 * read it back with an independent decoder (jsqr, a dev dependency used only here).
 */

/** The dark modules of a `qrPath` path, read back from its `M x y h w v1 h-w z` runs. */
function modules(d: string, size: number): boolean[][] {
  const m = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const runs = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
  expect(runs.map((r) => r[0]).join("")).toBe(d);
  for (const [, x, y, w, back] of runs) {
    expect(back).toBe(w);
    for (let i = 0; i < Number(w); i++) m[Number(y)][Number(x) + i] = true;
  }
  return m;
}

/** The path as RGBA pixels, `scale` pixels a module, dark modules black on white. */
function raster(d: string, size: number, scale = 4): { px: Uint8ClampedArray; w: number } {
  const m = modules(d, size);
  const w = size * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    if (!m[Math.floor(y / scale)][Math.floor(x / scale)]) continue;
    const o = (y * w + x) * 4;
    px[o] = px[o + 1] = px[o + 2] = 0;
  }
  return { px, w };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("the QR code encodes exactly the otpauth URI, computed on the page (rule 1620)", () => {
  it("decodes back to the very URI the setup hands out", () => {
    for (let i = 0; i < 5; i++) {
      const uri = otpauthUri(newTotpSecret(), "founder console");
      const { size, d } = qrPath(uri);
      const { px, w } = raster(d, size);
      expect(jsQR(px, w, w)?.data).toBe(uri);
    }
  });
  it("draws the library's own matrix, module for module", () => {
    const uri = otpauthUri(newTotpSecret(), "founder console");
    const { size, d } = qrPath(uri);
    const lib = encode(uri, { ecc: "M", border: QR_QUIET });
    expect(size).toBe(lib.size);
    expect(modules(d, size)).toEqual(lib.data);
  });
  it("another URI gives another code", () => {
    const a = qrPath(otpauthUri(newTotpSecret(), "founder console")).d;
    expect(qrPath(otpauthUri(newTotpSecret(), "founder console")).d).not.toBe(a);
  });
});

describe("a scannable tile in both themes, built from SVG elements (rule 1621)", () => {
  it("keeps a quiet zone of four modules on every side", () => {
    const { size, d } = qrPath(otpauthUri(newTotpSecret(), "founder console"));
    const m = modules(d, size);
    for (let i = 0; i < QR_QUIET; i++) {
      expect(m[i].some(Boolean)).toBe(false);
      expect(m[size - 1 - i].some(Boolean)).toBe(false);
      expect(m.some((row) => row[i] || row[size - 1 - i])).toBe(false);
    }
  });
  it("renders a 200-pixel svg: paper tile, ink modules, both palette primitives the dark theme never re-points", () => {
    const html = renderToStaticMarkup(createElement(QrCode, { value: "otpauth://totp/x?secret=ABC", label: "L" }));
    expect(html).toMatch(/^<svg role="img" aria-label="L" viewBox="0 0 \d+ \d+" width="200" height="200"/);
    expect(html).toContain('<rect width="');
    expect(html).toContain("fill:var(--primitive-color-paper)");
    expect(html).toContain("fill:var(--primitive-color-ink)");
    const dark = readFileSync("src/app/theme-dark.css", "utf8");
    expect(dark).not.toMatch(/--primitive-color-(ink|paper)\s*:/);
  });
  it("injects no markup: no dangerouslySetInnerHTML, no SVG string from the library", () => {
    for (const f of ["src/components/admin/QrCode.tsx", "src/lib/qr.ts", "src/components/admin/SecondFactor.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|renderSVG/);
    }
  });
});

describe("words in Arabic and English, the key and link kept as the fallback (rule 1622)", () => {
  it("has the scan line, the label and the manual line in both languages", () => {
    expect(SF.ar.step1).toContain("امسح الرمز بتطبيق المصادقة، أو أضف المفتاح يدويًا");
    expect(SF.en.step1).toContain("Scan the code with your authenticator app, or add the key by hand");
    for (const lang of ["ar", "en"] as const) {
      expect(SF[lang].qrLabel.length).toBeGreaterThan(10);
      expect(SF[lang].manual.length).toBeGreaterThan(10);
    }
    expect(SF.ar.qrLabel).toMatch(/[؀-ۿ]/);
    expect(SF.ar.manual).toMatch(/[؀-ۿ]/);
    expect(SF.en.qrLabel).not.toMatch(/[؀-ۿ]/);
  });
  it("the label is the svg's accessible name in each language", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(createElement(QrCode, { value: "otpauth://totp/x?secret=ABC", label: SF[lang].qrLabel }));
      expect(html).toContain(`role="img" aria-label="${SF[lang].qrLabel}"`);
    }
  });
  it("the setup dialog shows the code from setup.uri, then the grouped key and the otpauth link", () => {
    const src = readFileSync("src/components/admin/SecondFactor.tsx", "utf8");
    const qr = src.indexOf("<QrCode value={setup.uri} label={S.qrLabel} />");
    expect(qr).toBeGreaterThan(src.indexOf("{S.step1}"));
    expect(src.indexOf("{S.manual}")).toBeGreaterThan(qr);
    expect(src.indexOf("{groups(setup.secret)}")).toBeGreaterThan(src.indexOf("{S.manual}"));
    expect(src.indexOf("href={setup.uri}")).toBeGreaterThan(src.indexOf("{groups(setup.secret)}"));
  });
});

describe("the secret never leaves the page for the QR (rule 1623)", () => {
  it("drawing the code makes no request, and the secret is not in the drawn markup", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const secret = newTotpSecret();
    const uri = otpauthUri(secret, "founder console");
    const html = renderToStaticMarkup(createElement(QrCode, { value: uri, label: SF.en.qrLabel }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toContain(secret);
    expect(html).not.toContain("otpauth");
    expect(html).not.toMatch(/https?:|<img|<image|href=|src=/);
  });
  it("no request, image or outside URL in the QR code, its component or the library", () => {
    const lib = readFileSync("node_modules/uqr/dist/index.mjs", "utf8");
    expect(lib).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|new Image\b|import\(/);
    expect(lib.match(/https?:\/\/[^\s"'`]+/g) ?? []).toEqual(["http://www.w3.org/2000/svg"]);
    for (const f of ["src/lib/qr.ts", "src/components/admin/QrCode.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/\bfetch\(|adminFetch|XMLHttpRequest|sendBeacon|https?:\/\/|<img|console\.|localStorage|sessionStorage|document\.cookie/);
    }
  });
  it("the setup dialog's only requests are POSTs to /api/admin/2fa with the code in the body, never a URL with the secret", () => {
    const src = readFileSync("src/components/admin/SecondFactor.tsx", "utf8");
    const calls = [...src.matchAll(/\b(?:adminFetch|fetch)\(([^,)]*)/g)].map((m) => m[1].trim());
    expect(calls).toEqual(['"/api/admin/2fa"']);
    expect(src).toContain('method: "POST"');
    expect(src).not.toMatch(/\?secret=|encodeURIComponent\(setup|console\.|localStorage|sessionStorage|router\.push\(/);
  });
});

describe("one small QR dependency, no TOTP dependency (rule 1624)", () => {
  it("uqr is pinned, has no dependencies of its own, and jsqr is for tests only", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies.uqr).toBe("0.1.3");
    expect(pkg.dependencies.jsqr).toBeUndefined();
    expect(pkg.devDependencies.jsqr).toBe("1.4.0");
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version: string; dependencies?: object; dev?: boolean }> };
    expect(lock.packages["node_modules/uqr"].version).toBe("0.1.3");
    expect(lock.packages["node_modules/uqr"].dependencies).toBeUndefined();
    expect(lock.packages["node_modules/jsqr"].dev).toBe(true);
    expect(Object.keys(lock.packages).some((k) => k.startsWith("node_modules/@rolldown/binding-linux-"))).toBe(true);
  });
});
