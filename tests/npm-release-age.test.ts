import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Rule 699: npm resolves no version younger than 7 days (founder decision 2026-10-08, supastarter adoption spec).
// The setting lives in the project .npmrc so every `npm install` here, the lockfile ritual in CLAUDE.md included,
// waits a week before taking a new release. npm 11.10 added `min-release-age`; it errors when `before` is set too.
const npmrc = readFileSync(".npmrc", "utf8");
const settings = npmrc
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#") && !l.startsWith(";"));

describe("rule 699: npm waits 7 days before installing a new package version", () => {
  it(".npmrc sets min-release-age=7, once", () => {
    expect(settings.filter((l) => /^min-release-age\s*=/.test(l))).toEqual(["min-release-age=7"]);
  });

  it("nothing in .npmrc turns the gate off or fights it", () => {
    for (const l of settings) expect(l, l).not.toMatch(/^(before|registry)\s*=/);
  });
});
