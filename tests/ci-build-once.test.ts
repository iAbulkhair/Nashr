import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBuild, webServerCommand } from "../e2e/web-server";

/**
 * Rules 1207-1210: CI builds the app once and the end-to-end server starts that build, and the Next build cache is
 * saved even when the suite fails. docs/system/tests/1207-ci-build-once.md lists the rules.
 */
const yml = readFileSync(".github/workflows/ci.yml", "utf8");
const step = (name: string) => {
  const at = yml.indexOf(`      - name: ${name}\n`);
  if (at < 0) throw new Error(`no step ${name}`);
  const next = yml.indexOf("\n      - ", at + 1);
  return yml.slice(at, next < 0 ? yml.length : next);
};
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe("rule 1207: in CI the end-to-end server starts the Build step's build instead of building again", () => {
  it("CI with a build present runs only next start; without CI or without a build it builds first", () => {
    expect(webServerCommand(3210, { ci: true, prebuilt: true })).toBe("npx next start -p 3210");
    expect(webServerCommand(3210, { ci: true, prebuilt: false })).toBe("npm run build:hostinger && npx next start -p 3210");
    expect(webServerCommand(3210, { ci: false, prebuilt: true })).toBe("npm run build:hostinger && npx next start -p 3210");
    expect(webServerCommand(4000, { ci: false, prebuilt: false })).toBe("npm run build:hostinger && npx next start -p 4000");
  });

  it("a build is present only when .next/BUILD_ID exists; a restored .next/cache alone is not a build", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-build-"));
    roots.push(root);
    expect(hasBuild(root)).toBe(false);
    mkdirSync(join(root, ".next", "cache"), { recursive: true });
    expect(hasBuild(root)).toBe(false);
    writeFileSync(join(root, ".next", "BUILD_ID"), "abc");
    expect(hasBuild(root)).toBe(true);
  });

  it("playwright.config.ts uses the helper and still sets APP_ENV=test on the server, never reusing one", () => {
    const cfg = readFileSync("playwright.config.ts", "utf8");
    expect(cfg).toMatch(/import \{ hasBuild, webServerCommand \} from "\.\/e2e\/web-server";/);
    expect(cfg).toMatch(/const isCI = !!process\.env\.CI;/);
    expect(cfg).toMatch(/command: webServerCommand\(PORT, \{ ci: isCI, prebuilt: hasBuild\(\) \}\),/);
    expect(cfg).toMatch(/env: \{ APP_ENV: "test" \},/);
    expect(cfg).toMatch(/reuseExistingServer: false,/);
  });

  it("CI builds once: the Build step runs before the suite, the suite step builds nothing, the cap stays 25 minutes", () => {
    expect(yml.match(/^\s+run: .*\bbuild\b.*$/gm)).toEqual(["        run: npm run build:hostinger"]);
    expect(yml.indexOf("- name: Build\n")).toBeLessThan(yml.indexOf("- name: End-to-end tests"));
    expect(step("End-to-end tests")).toMatch(/run: npx playwright test\n?$/);
    expect(yml.match(/timeout-minutes: (\d+)/g)).toEqual(["timeout-minutes: 25"]);
  });
});

describe("rule 1208: the Next build cache is saved right after the build, so a red or cancelled suite keeps it", () => {
  it("restore before the build, save straight after it under the same key, skipped on an exact hit", () => {
    const restore = step("Restore Next build cache");
    const save = step("Save Next build cache");
    expect(restore).toMatch(/id: next-cache\n/);
    expect(restore).toMatch(/uses: actions\/cache\/restore@[0-9a-f]{40} # v4\.\d+\.\d+\n/);
    expect(save).toMatch(/uses: actions\/cache\/save@[0-9a-f]{40} # v4\.\d+\.\d+\n/);
    expect(save).toMatch(/if: steps\.scope\.outputs\.build == 'true' && steps\.next-cache\.outputs\.cache-hit != 'true'\n/);
    expect(save).toMatch(/path: \$\{\{ github\.workspace \}\}\/\.next\/cache\n/);
    expect(save).toMatch(/key: \$\{\{ steps\.next-cache\.outputs\.cache-primary-key \}\}/);
    const at = (s: string) => yml.indexOf(`- name: ${s}\n`);
    expect(at("Restore Next build cache")).toBeLessThan(at("Build"));
    // The save is the very next step after the build: nothing slower can fail or be cancelled in between.
    expect(yml.slice(at("Build")).split("\n      - ")[1]).toMatch(/^name: Save Next build cache\n/);
  });

  it("no combined actions/cache step holds .next/cache any more (its post-job save is skipped when the job fails)", () => {
    expect(yml).not.toMatch(/- name: Cache Next build\n/);
    const combined = yml.split("\n      - ").filter((s) => /uses: actions\/cache@[0-9a-f]{40} # v4\.\d+\.\d+/.test(s));
    for (const s of combined) expect(s).not.toMatch(/\.next\/cache/);
  });

  it("restore-keys fall back to the same lockfile, then to any Next cache of the runner's OS", () => {
    expect(step("Restore Next build cache")).toMatch(
      /restore-keys: \|\n\s+nextjs-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}-\n\s+nextjs-\$\{\{ runner\.os \}\}-\n/,
    );
  });
});

describe("rule 1209: one build serves both checks because APP_ENV is read at runtime only", () => {
  it("the Build step sets no APP_ENV (built like thakeen.com), and nothing in the workflow does", () => {
    expect(step("Build")).not.toMatch(/APP_ENV|env:/);
    expect(yml).not.toMatch(/^\s+APP_ENV:/m);
  });

  it("APP_ENV is read only inside deploy-env.ts and verify-email.ts, at call time", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    walk("src");
    const readers = files.filter((f) => /process\.env\.APP_ENV|process\.env\[["']APP_ENV/.test(readFileSync(f, "utf8"))).sort();
    expect(readers).toEqual(["src/lib/deploy-env.ts", "src/lib/verify-email.ts"]);
  });

  it("the only build-time readers (robots, sitemap) ask isStaging, which is false both unset and under test", async () => {
    for (const f of ["src/app/robots.ts", "src/app/sitemap.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/isStaging\(\)/);
      expect(src).not.toMatch(/isProductionDeploy|process\.env/);
    }
    const { isStaging } = await import("@/lib/deploy-env");
    const before = process.env.APP_ENV;
    try {
      delete process.env.APP_ENV;
      expect(isStaging()).toBe(false);
      process.env.APP_ENV = "test";
      expect(isStaging()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = before;
    }
  });
});

describe("rule 1210: the docs name the change", () => {
  it("flows section 62 and the coverage file describe it", () => {
    const flows = readFileSync("docs/system/flows.md", "utf8");
    expect(flows).toMatch(/rule 1207/);
    expect(flows).toMatch(/rule 1208/);
    const f = readFileSync("docs/system/tests/1207-ci-build-once.md", "utf8");
    for (let r = 1207; r <= 1210; r++) expect(f).toContain(`| ${r} |`);
  });
});
