import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CAST } from "@/lib/home";

/**
 * Rule 510. The product wears prototype D's palette (spec docs/superpowers/specs/2026-10-04-thakeen-reskin-design.md §1):
 * plum ink on a pearl ground, and one colour per cast member. `assets/design-tokens.json` is the one source; `tokens.css`
 * is its CSS form, kept by hand, so this test holds the two together value for value. The old oasis green, saffron yellow,
 * sadu red, salt and mist values must not come back.
 */
const read = (p: string) => readFileSync(p, "utf8");
const css = read("src/app/tokens.css");
const json = read("assets/design-tokens.json");

/** Every `--name: value;` in tokens.css, keyed by name without the leading dashes. */
const vars = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

type Leaf = { $value: string; $type: string };
type Tree = { [k: string]: Tree | Leaf | string };
const tokens = JSON.parse(json) as Tree;
const isLeaf = (n: unknown): n is Leaf => typeof n === "object" && n !== null && "$value" in n;

/** Follows `{primitive.color.ink}` references to the literal value. */
function resolve(v: string): string {
  const ref = /^\{([\w.-]+)\}$/.exec(v);
  if (!ref) return v;
  const node = ref[1].split(".").reduce<unknown>((n, k) => (n as Tree)[k], tokens);
  if (!isLeaf(node)) throw new Error(`dangling reference ${v}`);
  return resolve(node.$value);
}

/** The CSS name a JSON leaf takes: primitives keep their `primitive-` prefix, the semantic and component layers drop theirs. */
function leaves(n: Tree, path: string[] = []): [string, string][] {
  return Object.entries(n).flatMap(([k, c]) => {
    if (k.startsWith("$")) return [];
    if (isLeaf(c)) {
      const [layer, ...rest] = [...path, k];
      return [[layer === "primitive" ? ["primitive", ...rest].join("-") : rest.join("-"), resolve(c.$value)] as [string, string]];
    }
    return leaves(c as Tree, [...path, k]);
  });
}

const BASE = { ink: "#2b193d", muted: "#5d4a70", paper: "#ffffff", ground: "#f7f3f9", lilac: "#efe7f7", lemon: "#f9f871", gold: "#c9a227", danger: "#cc0000" };
const AGENTS = { noor: "#f9f871", sami: "#ff5da2", razan: "#00d9ff", faris: "#b517ff", dana: "#14b8a6", majed: "#2b193d", layan: "#3fcf7e", reem: "#ff8a1f", you: "#ffffff" };
const OLD = ["#0F3D3A", "#0A2B29", "#061C1B", "#F2B33D", "#F5C25E", "#D99A1F", "#D9503F", "#B93F30", "#101418", "#E9F0EC", "#A9BFB8", "#F6F4EE", "#EBE7DC"];

describe("the palette is prototype D's (rule 510)", () => {
  it("defines D's base, highlight, figure and error colours", () => {
    for (const [name, hex] of Object.entries(BASE)) expect(vars[`color-${name}`]?.toLowerCase(), name).toBe(hex);
  });

  it("gives each of the nine cast members D's colour", () => {
    for (const [id, hex] of Object.entries(AGENTS)) expect(vars[`color-agent-${id}`]?.toLowerCase(), id).toBe(hex);
  });

  it("points the semantic layer at D", () => {
    const want = { background: "ground", "background-muted": "lilac", surface: "paper", foreground: "ink", primary: "ink", "primary-foreground": "paper", accent: "lemon", "accent-foreground": "ink", "danger-foreground": "paper", "inverse-background": "ink", "inverse-surface": "ink", "inverse-foreground": "paper", "inverse-muted": "lilac", ring: "ink" } as const;
    for (const [role, base] of Object.entries(want)) expect(vars[`color-${role}`]?.toLowerCase(), role).toBe(BASE[base]);
  });

  it("carries D's strokes, easing and three durations", () => {
    expect([vars["stroke-pen"], vars["stroke-figure"], vars["stroke-fine"], vars["stroke-gold"], vars["stroke-focus"]]).toEqual(["1.25px", "1.5px", "1px", "1.75px", "2px"]);
    expect(vars["ease-out"]).toBe("cubic-bezier(.22,1,.36,1)");
    expect([vars["duration-fast"], vars["duration-normal"], vars["duration-slow"]]).toEqual(["150ms", "200ms", "300ms"]);
  });

  it("keeps no oasis, saffron, sadu, salt or mist hex", () => {
    for (const hex of OLD) {
      expect(css.toLowerCase(), `tokens.css ${hex}`).not.toContain(hex.toLowerCase());
      expect(json.toLowerCase(), `design-tokens.json ${hex}`).not.toContain(hex.toLowerCase());
    }
  });

  it("matches design-tokens.json value for value", () => {
    const all = leaves(tokens);
    expect(all.length).toBeGreaterThan(40);
    for (const [name, value] of all) expect(vars[name], name).toBe(value);
  });

  it("the homepage cast reads its colour from the tokens", () => {
    for (const m of CAST) expect(m.color, m.id).toBe(`var(--color-agent-${m.id})`);
  });

  it("the homepage stylesheet keeps no palette of its own", () => {
    const home = read("src/components/home/home.module.css");
    expect(home).not.toMatch(/#[0-9a-f]{6}\b/i);
    expect(home).not.toMatch(/--c-[a-z]+\s*:/);
  });
});
