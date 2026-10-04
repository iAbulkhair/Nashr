import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { scribble, type ScribbleKind } from "@/lib/scribble";
import Scribble from "@/components/Scribble";

/**
 * Rule 512. The hand-drawn pen of prototype D (`scribble.js`), ported to a typed module: the same seed always draws the
 * same line, so the server and the browser agree and a page never flickers between two drawings. The component draws on
 * the server first and hides in forced-colours mode, where real borders take its place.
 */
const KINDS: ScribbleKind[] = ["box", "bubble", "circleLoop", "cloud", "divider", "pill", "puddle", "stamp", "strike", "swash", "tape", "tick", "underline"];
/** What the shape draws: its line, or for the swash and the divider their filled outline (as `Scribble[kind]()` in D). */
const drawn = (k: ScribbleKind) => { const a = scribble(k, 200, 60, "s"); return a.d || a.ink || a.fill || ""; };
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("the pen draws the same line for the same seed (rule 512)", () => {
  it("is deterministic", () => {
    expect(scribble("box", 200, 60, "hero")).toEqual(scribble("box", 200, 60, "hero"));
    expect(scribble("bubble", 240, 80, "q", { tail: "start", rtl: true })).toEqual(scribble("bubble", 240, 80, "q", { tail: "start", rtl: true }));
  });

  it("varies with the seed", () => {
    expect(scribble("box", 200, 60, "a").d).not.toBe(scribble("box", 200, 60, "b").d);
  });

  it("draws every kind", () => {
    for (const k of KINDS) {
      const d = drawn(k);
      expect(d, k).toMatch(/^[MCQLZ0-9 .\-]+$/);
      expect(numbers(d).length, k).toBeGreaterThan(4);
      expect(numbers(d).every(Number.isFinite), k).toBe(true);
    }
  });

  it("rounds every coordinate to one decimal", () => {
    for (const k of KINDS) for (const n of numbers(drawn(k))) expect(Math.round(n * 10) / 10, k).toBe(n);
  });

  it("keeps a box near its frame", () => {
    const xs = numbers(scribble("box", 200, 60, "s").d).filter((_, i) => i % 2 === 0);
    expect(xs.length).toBeGreaterThan(10);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(-8);
      expect(x).toBeLessThanOrEqual(208);
    }
  });

  it("points a bubble's tail to the reading side", () => {
    const ltr = scribble("bubble", 240, 80, "t", { tail: "start" }).capFill ?? "";
    const rtl = scribble("bubble", 240, 80, "t", { tail: "start", rtl: true }).capFill ?? "";
    expect(numbers(ltr)[0]).toBeLessThan(10);
    expect(numbers(rtl)[0]).toBeGreaterThan(230);
    expect(scribble("bubble", 240, 80, "t", { tail: "none" }).cap).toBeUndefined();
  });

  it("renders on the server", () => {
    const html = renderToString(createElement(Scribble, { kind: "box", seed: "t" }));
    expect(html).toContain("<svg");
    expect(html).toContain('d="M');
    expect(html).toContain('aria-hidden="true"');
    expect(renderToString(createElement(Scribble, { kind: "box", seed: "t" }))).toBe(html);
  });

  it("fills with a token or a colour", () => {
    expect(renderToString(createElement(Scribble, { kind: "pill", seed: "t", fill: "agent-sami" }))).toContain("--s-fill:var(--color-agent-sami)");
    expect(renderToString(createElement(Scribble, { kind: "pill", seed: "t", fill: "#123456" }))).toContain("--s-fill:#123456");
  });

  it("hides in forced colours and keeps real borders", () => {
    const css = readFileSync("src/app/scribble.css", "utf8");
    const forced = /@media \(forced-colors: ?active\)\s*\{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? "";
    expect(forced).toMatch(/\.scribble\s*\{\s*display:\s*none/);
    for (const c of [".s-btn", ".s-card", ".s-input"]) expect(forced, c).toContain(c);
    expect(forced).toContain("CanvasText");
    expect(readFileSync("src/app/globals.css", "utf8")).toContain('@import "./scribble.css"');
  });

  it("steps the native focus outline aside only outside forced colours, so Windows contrast themes keep a focus mark", () => {
    const css = readFileSync("src/app/scribble.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const hide = css.indexOf("outline-color: transparent");
    expect(hide).toBeGreaterThan(-1);
    const block = /@media \(forced-colors: none\)\s*\{[\s\S]*?outline-color: transparent;[\s\S]*?\}\s*\}/.exec(css);
    expect(block?.[0], "the outline-hiding rule sits inside @media (forced-colors: none)").toBeTruthy();
    expect(css.split("outline-color: transparent").length - 1).toBe(1);
  });
});

describe("Arabic speech tails point the right way before any script runs (rule 512)", () => {
  // The server cannot read the computed direction, so homepage sections that draw tailed bubbles pass it from `lang`.
  // Without it an Arabic "start" tail would point left, away from the speaker, until hydration.
  it("the Arabic Rules panel is drawn right to left on the server", async () => {
    const { default: Rules } = await import("@/components/home/Rules");
    const html = renderToString(createElement(Rules, { lang: "ar" }));
    const rtl = scribble("bubble", 240, 80, "rb00", { tail: "start", rtl: true }).cap;
    const ltr = scribble("bubble", 240, 80, "rb00", { tail: "start", rtl: false }).cap;
    expect(rtl).not.toBe(ltr);
    expect(html).toContain(`d="${rtl}"`);
    expect(renderToString(createElement(Rules, { lang: "en" }))).toContain(`d="${ltr}"`);
  });

  it("every tailed scribble, bubble and cloud in a homepage section is told its direction", () => {
    for (const f of ["Rules", "Day", "Steps", "Plans"]) {
      const src = readFileSync(`src/components/home/${f}.tsx`, "utf8");
      // A bubble or cloud draws a tail even when none is named (it defaults to the bottom, placed from the start side).
      for (const tag of src.match(/<Scribble [^>]*(?:tail=|kind="(?:bubble|cloud)")[^>]*\/>/g) ?? []) expect(tag, `${f}: ${tag}`).toMatch(/\brtl=\{/);
    }
  });
});
