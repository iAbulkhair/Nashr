import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Rule 772: CI stays inside the plan's Actions minutes without losing a check. Every pull request runs the job and
 * reports "Nashr CI"; draft PRs skip the end-to-end suite, which runs once a PR is ready for review; a change to docs
 * only runs the unit tests alone. Rule 988 (2026-10-10): pull requests only, no push run on main; that run existed only
 * for the old Vercel project's Deployment Check. Next's build cache and Playwright's browsers are cached. The Scope step's shell is executed here for real, in throwaway git
 * repositories, so the test pins what CI decides.
 */
const yml = readFileSync(".github/workflows/ci.yml", "utf8");
/** One step's text, from its `- name:` line to the next step. */
const step = (name: string) => {
  const at = yml.indexOf(`      - name: ${name}\n`);
  if (at < 0) throw new Error(`no step ${name}`);
  const next = yml.indexOf("\n      - ", at + 1);
  return yml.slice(at, next < 0 ? yml.length : next);
};
/** The Scope step's `run: |` block, de-indented. */
const scopeScript = step("Scope").split("run: |\n")[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@test.example", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@test.example" } }).trim();
const write = (root: string, files: string[]) => { for (const f of files) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), `${f} ${Math.random()}\n`); } };

/** A repository with a base commit, then `files` changed as a PR, checked out as GitHub's merge commit. */
function scope(files: string[], how: { draft: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ["src/app.ts", "docs/a.md"]);
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  write(root, files);
  git(root, "add", "-A"); git(root, "commit", "-qm", "change");
  git(root, "checkout", "-q", "main");
  write(root, ["unrelated-on-main.txt"]);
  git(root, "add", "-A"); git(root, "commit", "-qm", "main moved");
  git(root, "merge", "-q", "--no-ff", "-m", "merge ref", "feature");
  const out = join(root, "github_output");
  writeFileSync(out, "");
  execFileSync("bash", ["-e", "-c", scopeScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: out,
      DRAFT: String(how.draft),
    },
  });
  return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]));
}

/** A cached step's `with:` block must name `path` and `key`; returns that step's text. */
const cacheStep = (name: string) => {
  const s = step(name);
  expect(s, name).toMatch(/uses: actions\/cache@[0-9a-f]{40} # v4\.\d+\.\d+/);
  return s;
};

describe("rule 772: CI checks every change and runs the end-to-end suite where it counts", () => {
  it("the job always runs and reports Nashr CI: no workflow-level path filter, drafts marked ready start a run", () => {
    expect(yml).toMatch(/\n    name: Nashr CI\n/);
    const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\nconcurrency:"));
    expect(on).not.toMatch(/paths(-ignore)?:/);
    expect(on).toMatch(/types: \[opened, synchronize, reopened, ready_for_review\]/);
  });

  it("rule 988: pull requests only, no push run on main and nothing left that only a push would run", () => {
    const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\nconcurrency:"));
    expect(on).toBe("\non:\n  pull_request:\n    # ready_for_review: marking a draft ready starts the full suite (see the Scope step).\n    types: [opened, synchronize, reopened, ready_for_review]\n");
    expect(yml).not.toMatch(/event_name|\$EVENT|EVENT:/);
    expect(yml).not.toMatch(/- name: Seed Playwright cache/);
  });

  it("unit tests run unless Scope reuses a green run (rule 2551); build, type-check and lint follow Scope's build; the e2e suite follows Scope's e2e", () => {
    expect(step("Unit tests")).toMatch(/if: steps\.scope\.outputs\.unit != 'none'\n/);
    for (const s of ["Build", "Type-check", "Lint", "Restore Next build cache", "Save Next build cache"]) expect(step(s), s).toMatch(/if: steps\.scope\.outputs\.build == 'true'/);
    expect(step("End-to-end tests")).toMatch(/if: steps\.scope\.outputs\.e2e == 'true'\n/);
    expect(step("Upload Playwright report")).toMatch(/if: failure\(\) && steps\.scope\.outputs\.e2e == 'true'/);
  });

  it("a ready PR that touches code runs everything; a draft skips only the e2e suite", () => {
    expect(scope(["src/lib/x.ts"], { draft: false })).toEqual({ build: "true", e2e: "true", unit: "all", reused: "false" });
    expect(scope(["src/lib/x.ts", "docs/b.md"], { draft: true })).toEqual({ build: "true", e2e: "false", unit: "affected", reused: "false" });
  });

  it("docs/, .archify/ and top-level .md files alone are docs-only; product content in .md is not", () => {
    expect(scope(["docs/system/tests.md", "docs/system/tests/0788-x.md", "README.md", ".archify/x/y.png"], { draft: false })).toEqual({ build: "false", e2e: "false", unit: "all", reused: "false" });
    expect(scope(["content/skills/ads.md"], { draft: false })).toEqual({ build: "true", e2e: "true", unit: "all", reused: "false" });
    expect(scope([".github/workflows/ci.yml"], { draft: false })).toEqual({ build: "true", e2e: "true", unit: "all", reused: "false" });
  });

  it("Next's build cache is restored before the build, keyed on the lockfile and the sources", () => {
    const c = step("Restore Next build cache");
    expect(c).toMatch(/uses: actions\/cache\/restore@[0-9a-f]{40} # v4\.\d+\.\d+/);
    expect(yml.indexOf("- name: Restore Next build cache")).toBeLessThan(yml.indexOf("- name: Build\n"));
    expect(c).toMatch(/path: \$\{\{ github\.workspace \}\}\/\.next\/cache\n/);
    expect(c).toMatch(/key: nextjs-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}-\$\{\{ hashFiles\('src\/\*\*'/);
    expect(c).toMatch(/restore-keys: \|\n\s+nextjs-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}-\n/);
  });

  it("Playwright's browsers are cached by version: a hit installs only the system packages, a miss downloads", () => {
    expect(step("Playwright version")).toMatch(/require\('@playwright\/test\/package\.json'\)\.version/);
    expect(step("Playwright version")).toMatch(/if: steps\.scope\.outputs\.e2e == 'true'\n/);
    const c = cacheStep("Cache Playwright browsers");
    expect(c).toMatch(/path: ~\/\.cache\/ms-playwright\n/);
    expect(c).toMatch(/key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ steps\.playwright\.outputs\.version \}\}-/);
    const miss = step("Install Playwright browsers");
    expect(miss).toMatch(/if: steps\.scope\.outputs\.e2e == 'true' && steps\.playwright-cache\.outputs\.cache-hit != 'true'/);
    expect(miss).toMatch(/run: npx playwright install --with-deps chromium webkit/);
    const hit = step("Install Playwright system dependencies");
    expect(hit).toMatch(/if: steps\.scope\.outputs\.e2e == 'true' && steps\.playwright-cache\.outputs\.cache-hit == 'true'/);
    expect(hit).toMatch(/run: npx playwright install-deps chromium webkit/);
    // Every browser step comes before the suite that needs it.
    for (const s of ["Cache Playwright browsers", "Install Playwright browsers", "Install Playwright system dependencies"]) {
      expect(yml.indexOf(`- name: ${s}`), s).toBeLessThan(yml.indexOf("- name: End-to-end tests"));
    }
  });
});
