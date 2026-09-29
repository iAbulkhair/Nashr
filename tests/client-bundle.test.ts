import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Server-only code must not reach the browser bundle. The specific trap this pins: `src/lib/brand.ts` opens with
 * `import { db } from "./db"`, and `db` constructs the Upstash Redis client. A client component that imports a VALUE
 * from `brand.ts` — a price, a batch size — therefore pulls the whole Redis client into its chunk. It did: before this
 * was fixed, five authenticated pages shipped a 96 KB chunk containing `@upstash/redis` to every signed-in browser.
 * Type-only imports are erased and are fine.
 */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });

/** Modules that reach the store, a provider SDK or a secret, directly or through one hop. */
const SERVER_ONLY = ["@/lib/db", "@/lib/brand", "@/lib/auth", "@/lib/credits", "@/lib/usage", "@/lib/mcp", "@/lib/oauth", "@/lib/files", "@/lib/chat", "@/lib/noor", "@/lib/judge", "@/lib/golden", "@/lib/account", "@/lib/connectors/store", "@/lib/journey-load", "@/lib/perf-store", "@/lib/media/config", "@/lib/media/jobs", "@/lib/media/registry", "@/lib/media/start", "@/lib/media/fal", "@/lib/media/kie", "@/lib/media/higgsfield", "@/lib/media/blob", "@/lib/media/prompts", "@anthropic-ai/sdk", "@upstash/redis"];

const clientFiles = () => walk("src").filter((p) => /^\s*["']use client["']/.test(readFileSync(p, "utf8")));

describe("the browser bundle stays free of server-only code", () => {
  it("finds the client components, so an empty result cannot pass by accident", () => {
    expect(clientFiles().length).toBeGreaterThan(20);
  });

  it("no client component imports a VALUE from a server-only module", () => {
    const offenders: string[] = [];
    for (const file of clientFiles()) {
      const src = readFileSync(file, "utf8");
      for (const spec of SERVER_ONLY) {
        // `import type { X } from "..."` and `import { type X } from "..."` are erased by the compiler; a bare
        // `import { X } from "..."` is not.
        const re = new RegExp(`import\\s+(?!type\\s)\\{([^}]*)\\}\\s+from\\s+["']${spec.replace(/[/@]/g, "\\$&")}["']`, "g");
        for (const m of src.matchAll(re)) {
          const values = m[1].split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "));
          if (values.length) offenders.push(`${file} imports { ${values.join(", ")} } from "${spec}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the task catalogue the client reads imports nothing at all", () => {
    const src = readFileSync("src/lib/tasks.ts", "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(imports, "src/lib/tasks.ts must stay import-free or the leak comes back through it").toEqual([]);
  });

  it("the media catalogue the inbox reads imports nothing at all", () => {
    const src = readFileSync("src/lib/media-catalog.ts", "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(imports, "src/lib/media-catalog.ts must stay import-free or the leak comes back through it").toEqual([]);
  });

  it("brand.ts still re-exports the catalogue, so server callers are unaffected", async () => {
    const brand = await import("@/lib/brand");
    const tasks = await import("@/lib/tasks");
    expect(brand.TASK_COST).toBe(tasks.TASK_COST);
    expect(brand.TASK_COUNT).toBe(tasks.TASK_COUNT);
    expect(brand.IMAGE_TYPES).toBe(tasks.IMAGE_TYPES);
    expect(brand.VIDEO_TYPES).toBe(tasks.VIDEO_TYPES);
    expect(brand.IMAGE_COST).toBe(tasks.IMAGE_COST);
  });
});
