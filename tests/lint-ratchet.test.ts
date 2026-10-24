import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { A11Y_RATCHETED, TYPE_RATCHETED, a11yRules, typeAwareRules } from "../eslint-rules/tooling-rules.mjs";
import { measure, readRatchet } from "../eslint-rules/ratchet.mjs";
import { pickSkillsDict } from "@/lib/skills-admin-dict";
import { appDict } from "@/lib/app-i18n";

// Rules 2090-2097 (wave 2e): jsx-a11y and the type-aware promise rules. The zero-violation rules are errors, the others are
// warnings whose count may only go down. docs/system/tests/2090-perf-a11y-lint.md.
const config = readFileSync("eslint.config.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

describe("jsx-a11y in the flat config (rules 2090-2091)", () => {
  it("2090: eslint-plugin-jsx-a11y is a direct devDependency and the config applies its rules to src tsx files", () => {
    expect(pkg.devDependencies["eslint-plugin-jsx-a11y"]).toBeTruthy();
    expect(config).toContain('from "eslint-plugin-jsx-a11y"');
    expect(config).toMatch(/files: \["src\/\*\*\/\*\.tsx"\], rules: a11yRules\(/);
  });

  it("2091: every recommended rule that is on is an error, except the ratcheted ones, which are warnings", () => {
    const rules = a11yRules({
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/no-autofocus": "error",
      "jsx-a11y/aria-role": ["error", { ignoreRoles: ["x"] }],
      "jsx-a11y/control-has-associated-label": ["off", {}],
    });
    const level = (r: unknown) => (Array.isArray(r) ? r[0] : r);
    expect(level(rules["jsx-a11y/alt-text"])).toBe("error");
    expect(level(rules["jsx-a11y/no-autofocus"])).toBe("warn");
    expect(level(rules["jsx-a11y/aria-role"])).toBe("error");
    expect(rules["jsx-a11y/control-has-associated-label"]).toBeUndefined();
    // Options from the recommended set survive and ours are merged on top.
    expect(rules["jsx-a11y/aria-role"][1]).toEqual({ ignoreRoles: ["x"], ignoreNonDOM: true });
  });
});

describe("a11y options with a reason (rule 2093)", () => {
  const rules = a11yRules({
    "jsx-a11y/aria-role": "error",
    "jsx-a11y/label-has-associated-control": "error",
    "jsx-a11y/no-redundant-roles": "error",
  });
  it("2093: component props named role are not DOM roles, a label wrapping nested spans is labelled, lists keep role=list for VoiceOver", () => {
    expect(rules["jsx-a11y/aria-role"]).toEqual(["error", { ignoreNonDOM: true }]);
    expect(rules["jsx-a11y/label-has-associated-control"]).toEqual(["error", { depth: 3 }]);
    expect(rules["jsx-a11y/no-redundant-roles"]).toEqual(["error", { ul: ["list"], ol: ["list"] }]);
  });
});

describe("type-aware promise rules (rules 2094-2095)", () => {
  it("2094: the config turns on projectService for src and the three promise rules", () => {
    expect(config).toMatch(/projectService: true/);
    for (const r of ["no-floating-promises", "no-misused-promises", "await-thenable"]) expect(Object.keys(typeAwareRules)).toContain(`@typescript-eslint/${r}`);
  });

  it("2095: only ratcheted type-aware rules are warnings; the rest are errors", () => {
    const level = (r: unknown) => (Array.isArray(r) ? r[0] : r);
    for (const [name, entry] of Object.entries(typeAwareRules)) expect(level(entry)).toBe(TYPE_RATCHETED.includes(name) ? "warn" : "error");
    expect(typeAwareRules["@typescript-eslint/no-misused-promises"][1]).toEqual({ checksVoidReturn: { attributes: false } });
  });
});

describe("the ratchet (rules 2092, 2096)", () => {
  it("2092: ratchet.json names exactly the ratcheted rules, each with a positive count", () => {
    const { rules } = readRatchet();
    expect(Object.keys(rules).sort()).toEqual([...A11Y_RATCHETED, ...TYPE_RATCHETED].sort());
    for (const n of Object.values(rules)) expect(n).toBeGreaterThan(0);
  });

  it("2096: src has no lint error and no ratcheted rule is above its count (the number may only go down)", async () => {
    const { counts, errors } = await measure();
    expect(errors).toEqual([]);
    const { rules } = readRatchet();
    const above = Object.entries(rules).filter(([rule, max]) => (counts[rule] ?? 0) > (max as number)).map(([rule, max]) => `${rule}: ${counts[rule]} > ${max}`);
    expect(above, "a new violation: fix it, or fix an old one in the same change").toEqual([]);
  }, 240_000);
});

describe("floating and misused promises are errors, not ratcheted (rule 2097)", () => {
  it("2097: only await-thenable is on the type-aware ratchet; fire-and-forget calls in handlers are marked with void", () => {
    expect(TYPE_RATCHETED).toEqual(["@typescript-eslint/await-thenable"]);
    expect(Array.isArray(typeAwareRules["@typescript-eslint/no-floating-promises"]) ? typeAwareRules["@typescript-eslint/no-floating-promises"][0] : typeAwareRules["@typescript-eslint/no-floating-promises"]).toBe("error");
    expect(readFileSync("src/components/app/ChatPanel.tsx", "utf8")).toContain("void send(text)");
  });
});

describe("measured performance (rules 2098-2101)", () => {
  it("2098: the skills console gets its words from the page; the client panel never imports the whole dictionary", () => {
    const panel = readFileSync("src/components/admin/SkillsAdminPanel.tsx", "utf8");
    expect(panel).not.toMatch(/import \{[^}]*\bappDict\b[^}]*\} from/);
    expect(panel).toContain("dict: SkillsDict");
    const page = readFileSync("src/app/[lang]/admin/skills/page.tsx", "utf8");
    expect(page).toContain("dict={pickSkillsDict(appDict[lang])}");
    // The picked part holds exactly what the panel and the editor read.
    for (const lang of ["ar", "en"] as const) {
      expect(Object.keys(pickSkillsDict(appDict[lang])).sort()).toEqual(["agents", "dialog", "files", "generate", "governance", "instructions", "lang"]);
    }
  });

  it("2098: no client component outside the founder-only ones imports the dictionary value", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) {
          const src = readFileSync(p, "utf8");
          if (/^["']use client["']/.test(src) && /import \{[^}]*\bappDict\b[^}]*\} from/.test(src)) hits.push(p);
        }
      }
    };
    walk("src");
    expect(hits).toEqual([]);
  });

  it("2099: the meeting panel loads on first click, through next/dynamic", () => {
    const todo = readFileSync("src/components/app/TodoPanel.tsx", "utf8");
    expect(todo).toContain('dynamic(() => import("./MeetingPanel"))');
    expect(todo).not.toMatch(/^import MeetingPanel from/m);
  });

  it("2100: scripts/route-sizes.mjs reads the build output and has a before/after diff mode", () => {
    const script = readFileSync("scripts/route-sizes.mjs", "utf8");
    expect(script).toContain("rootMainFiles");
    expect(script).toContain('"--diff"');
    expect(script).toContain("polyfills-");
  });

  // Since rule 3502 a third: PersonAvatar, a signed-in person's picture from our own `/api/avatar/` route (a fixed
  // 256 px square, so next/image would add nothing), falling back to the initial when it does not load. Since rule 3610 a
  // fourth: WorkspaceLogo, the workspace's logo from our own `/api/logo/` route, on the same terms.
  it("2101: the public site ships no raster image tags; the <img> in the signed-in app are for user media", () => {
    const raw: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(name) && /<img\b|next\/image/.test(readFileSync(p, "utf8"))) raw.push(p);
      }
    };
    walk("src");
    expect(raw.sort()).toEqual(["src/components/app/Inbox.tsx", "src/components/app/LibraryPanel.tsx", "src/components/app/PersonAvatar.tsx", "src/components/app/WorkspaceLogo.tsx"]);
  });
});
