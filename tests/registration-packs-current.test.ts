import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { COMPOSIO_ONLY, PROVIDERS, isDirectApp } from "@/lib/connectors/registry";
import { CALLBACK_PATH } from "@/lib/google-signin";

/**
 * docs/Registration_Packs.md opens with a "Current values" table the founder copies into each platform's portal
 * (rule 2164, docs/system/tests/2160-integrations-panel-drift.md), and the privacy anchors it links (rule 2167). On 2026-10-18 the packs below it still named the
 * retired nashr-tau host, `vercel env` steps and `MS_CLIENT_ID`, which the code never reads.
 */

const doc = readFileSync("docs/Registration_Packs.md", "utf8");
const start = doc.indexOf("## Current values");
const current = doc.slice(start, doc.indexOf("Written 2026-09-27", start));
const src = (readdirSync("src", { recursive: true }) as string[])
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
  .map((f) => readFileSync(path.join("src", f), "utf8"))
  .join("\n");

describe("Registration packs current values (rule 2164)", () => {
  it("sits above the dated packs and names only thakeen.com", () => {
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(doc.indexOf("## Shared values"));
    expect(current).not.toMatch(/nashr-tau|vercel\.app/);
  });

  it("lists every direct OAuth platform's callback and both key names, as registry.ts has them", () => {
    const direct = PROVIDERS.filter(isDirectApp);
    expect(direct.length).toBeGreaterThan(0);
    for (const p of direct) {
      expect(current, p.id).toContain(`\`https://thakeen.com/api/connect/${p.id}/callback\``);
      expect(current, p.id).toContain(`\`${p.oauth!.clientIdEnv}\``);
      expect(current, p.id).toContain(`\`${p.oauth!.clientSecretEnv}\``);
    }
    // No callback row for a platform that has no direct app.
    // Table rows only: the rule 2175 paragraph names the Composio-only callbacks that are never called.
    const table = current.split("\n").filter((l) => l.startsWith("| ")).join("\n");
    const ids = [...table.matchAll(/thakeen\.com\/api\/connect\/([a-z_]+)\/callback/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(direct.map((p) => p.id)));
  });

  it("names no callback and no client key for a Composio-only provider, and says they connect through Composio (rule 2175)", () => {
    for (const id of COMPOSIO_ONLY) expect(current, id).not.toContain(`/api/connect/${id}/callback\` |`);
    for (const id of ["linkedin", "tiktok", "google"]) expect(COMPOSIO_ONLY, id).toContain(id);
    const rows = current.split("\n").filter((l) => l.startsWith("| ") && l.includes("thakeen.com"));
    for (const n of ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]) expect(rows.join("\n"), n).not.toContain(n);
    expect(current).toMatch(/LinkedIn, TikTok and the Google connector[\s\S]*through Composio only/);
  });

  it("gives Sign in with Google its own client and callback", () => {
    expect(current).toContain(`\`https://thakeen.com${CALLBACK_PATH}\``);
    for (const n of ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"]) expect(current).toContain(`\`${n}\``);
  });

  it("the names it calls unread are really unread", () => {
    for (const n of ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "TIKTOK_ADS_APP_ID", "TIKTOK_ADS_SECRET"]) {
      expect(current).toContain(`\`${n}\``);
      expect(src.includes(n), n).toBe(false);
    }
  });
});

describe("Each platform is asked only for the scopes the code uses (rule 2174)", () => {
  it("every direct row's scopes column is the registry's list, word for word", () => {
    for (const p of PROVIDERS.filter(isDirectApp)) {
      const row = current.split("\n").find((l) => l.includes(`/api/connect/${p.id}/callback\``));
      expect(row, p.id).toBeTruthy();
      const cells = row!.split("|").map((c) => c.trim());
      // Google's rows name each scope by its last path segment (`https://www.googleapis.com/auth/business.manage` is `business.manage`).
      const short = p.oauth!.scopes.map((x) => (x.startsWith("https://") ? x.slice(x.lastIndexOf("/") + 1) : x));
      expect(cells[cells.length - 2], p.id).toBe(short.length ? `\`${short.join(" ")}\`` : "none in the URL");
    }
  });

  it("Shopify asks for read_products, read_orders and write_content only: every Admin call in shopify.ts needs one of them", () => {
    expect(PROVIDERS.find((p) => p.id === "shopify")?.oauth?.scopes).toEqual(["read_products", "read_orders", "write_content"]);
    const src = readFileSync("src/lib/connectors/shopify.ts", "utf8");
    // The root fields the connector calls, and the scope Shopify's Admin GraphQL reference names for each (2026-10-18).
    const NEEDS: Record<string, string> = { products: "read_products", orders: "read_orders", ordersCount: "read_orders", abandonedCheckouts: "read_orders", abandonedCheckoutsCount: "read_orders", blogs: "write_content", articleCreate: "write_content", shop: "", webhookSubscriptionCreate: "" };
    // The top-level fields of every operation: names at brace depth 1, before their arguments or selection.
    const roots = [...src.matchAll(/`((?:query|mutation) [\s\S]*?)`;/g)].flatMap(([, op]) => {
      const out: string[] = [];
      let depth = 0;
      for (const m of op.matchAll(/[{}]|\(.*?\)|[A-Za-z_]\w*/g)) {
        if (m[0] === "{") depth++;
        else if (m[0] === "}") depth--;
        else if (depth === 1 && /^[A-Za-z_]/.test(m[0])) out.push(m[0]);
      }
      return out;
    });
    expect(roots.length).toBeGreaterThan(0);
    for (const r of new Set(roots)) expect(Object.keys(NEEDS), `${r} has no scope listed here`).toContain(r);
  });
});

describe("Privacy anchors for platform app review (rule 2167)", () => {
  it("every privacy section has the same unique id in both languages, and the page renders it", async () => {
    const { LEGAL } = await import("@/lib/legal");
    const ids = (l: "ar" | "en") => LEGAL[l].privacy.sections.map((s) => s.id);
    expect(ids("ar")).toEqual(ids("en"));
    expect(ids("en").every((i) => typeof i === "string" && /^[a-z][a-z-]*$/.test(i))).toBe(true);
    expect(new Set(ids("en")).size).toBe(ids("en").length);
    // The two a platform app is given: never renamed.
    expect(ids("en")).toContain("deletion");
    expect(ids("en")).toContain("connected-platforms");
    expect(LEGAL.en.privacy.sections.find((s) => s.id === "deletion")?.p.join(" ")).toMatch(/delete your account yourself/);
    expect(readFileSync("src/app/[lang]/privacy/page.tsx", "utf8")).toContain("id={s.id}");
  });

  it("the current values give Meta the deletion anchor", () => {
    expect(current).toContain("`https://thakeen.com/en/privacy#deletion`");
    expect(current).toContain("`https://thakeen.com/en/privacy#connected-platforms`");
  });
});
