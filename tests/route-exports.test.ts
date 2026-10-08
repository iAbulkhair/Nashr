import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// A Next.js route module may export only its HTTP handlers and route segment config. The default (Turbopack) build
// tolerates other exports, but the webpack build's type check refuses them, so a shared constant belongs in src/lib.
// Source of the allowed names: node_modules/next/dist/build/webpack/plugins/next-types-plugin/index.js.
const ALLOWED = new Set([
  "GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH",
  "config", "generateStaticParams", "instant", "prefetch", "unstable_dynamicStaleTime",
  "revalidate", "dynamic", "dynamicParams", "fetchCache", "preferredRegion", "runtime", "maxDuration",
]);

// Exports that predate this rule. Moving them is its own change; this list may only shrink. It is empty since the
// Hostinger build (rule 661), which runs the webpack type check: SHARE_CREDITS, parseSlides and SIGNED_IN_PER_DAY now
// live in src/lib/referral.ts, src/lib/slides.ts and src/lib/tools.ts.
const LEGACY: Record<string, string[]> = {};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return routeFiles(p);
    // Next serves a handler from any of these extensions; a route.js is as much a route as a route.ts.
    return /^route\.(?:ts|tsx|js|jsx|mjs)$/.test(n) ? [p] : [];
  });
}

function exportedNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  // `export { a, b as c }` and `export { x } from "..."` export the name after `as`, or the name itself.
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    if (/^export\s+type\s/.test(m[0])) continue;
    for (const part of m[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p || part.trim().startsWith("type ")) continue;
      names.push(p.split(/\s+as\s+/).pop()!.trim());
    }
  }
  if (/^export\s+\*/m.test(src)) names.push("*");
  if (/^export\s+default\b/m.test(src)) names.push("default");
  return names;
}

describe("route modules export only handlers and route config", () => {
  const files = routeFiles(join("src", "app")).map((p) => relative(".", p).split(sep).join("/"));

  it("finds the route files", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/app/api/team/route.ts");
  });

  it("no route file exports anything else", () => {
    const bad: string[] = [];
    for (const f of files) {
      const extra = LEGACY[f] ?? [];
      for (const n of exportedNames(readFileSync(f, "utf8"))) if (!ALLOWED.has(n) && !extra.includes(n)) bad.push(`${f}: ${n}`);
    }
    expect(bad).toEqual([]);
  });

  it("the legacy list names only exports that still exist", () => {
    for (const [f, names] of Object.entries(LEGACY)) {
      const have = exportedNames(readFileSync(f, "utf8"));
      for (const n of names) expect(have, `${f} no longer exports ${n}; remove it from LEGACY`).toContain(n);
    }
  });

  it("the parser sees every export form", () => {
    const names = exportedNames([
      "export const A = 1;",
      "export async function POST() {}",
      "export function helper() {}",
      "export { x, y as Z } from './m';",
      "export type { T } from './t';",
      "export * from './all';",
      "export default function Page() {}",
    ].join("\n"));
    expect(names.sort()).toEqual(["*", "A", "POST", "Z", "default", "helper", "x"].sort());
  });
});
