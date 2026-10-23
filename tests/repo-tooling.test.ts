import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** Rules 3170-3174: repository tooling (docs/system/tests/3170-repo-tooling.md). */
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const majorMinor = (v: string) => v.replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".");
const workflows = readdirSync(".github/workflows").map((f) => readFileSync(`.github/workflows/${f}`, "utf8"));

describe("rule 3170: engines", () => {
  it("requires Node 22 or later, the version CI builds with", () => {
    expect(pkg.engines.node).toBe(">=22");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toMatch(/node-version: 22\b/);
  });
});

describe("rule 3171: coverage command", () => {
  it("has the script, a matching coverage package and an ignored output folder", () => {
    expect(pkg.scripts["test:coverage"]).toBe("vitest run --coverage");
    const cov = lock.packages["node_modules/@vitest/coverage-v8"].version as string;
    const vit = lock.packages["node_modules/vitest"].version as string;
    expect(pkg.devDependencies["@vitest/coverage-v8"]).toBeTruthy();
    expect(majorMinor(cov)).toBe(majorMinor(vit));
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain("/coverage");
  });
});

describe("rule 3172: coverage stays out of CI", () => {
  it("no workflow runs the coverage command", () => {
    for (const w of workflows) {
      expect(w).not.toMatch(/test:coverage|--coverage/);
    }
  });
});

describe("rule 3173: lockfile keeps the platform bindings", () => {
  it("lists the Linux rolldown bindings so npm ci works on Linux", () => {
    const names = Object.keys(lock.packages).filter((k) => k.startsWith("node_modules/@rolldown/binding-linux-"));
    expect(names.length).toBeGreaterThan(0);
  });
});

describe("rule 3174: editorconfig and README", () => {
  it("editorconfig matches the code style", () => {
    const ec = readFileSync(".editorconfig", "utf8");
    for (const line of ["charset = utf-8", "end_of_line = lf", "indent_style = space", "indent_size = 2", "insert_final_newline = true"]) {
      expect(ec).toContain(line);
    }
  });
  it("every path the README names exists", () => {
    const readme = readFileSync("README.md", "utf8");
    const paths = [...readme.matchAll(/`((?:docs\/|[A-Za-z.]+\.(?:md|example))[^`\s]*)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) expect(existsSync(p), p).toBe(true);
  });
});
