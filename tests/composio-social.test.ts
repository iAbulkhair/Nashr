import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composioWrite, setComposioClientForTests, type ComposioClient } from "@/lib/connectors/composio";
import { TOOLKITS, type Toolkit } from "@/lib/connectors/composio-catalog";
import type { Connection } from "@/lib/connectors/store";

/**
 * Rules 661-671: Instagram and LinkedIn page results read through Composio (social-stats.ts), and the owner's choice to
 * publish to LinkedIn as the page (docs/superpowers/specs/2026-10-08-social-results-via-composio-design.md). Read only:
 * the founder's rule of 2026-10-05 is that results are fetched and analysed, never posted, replied to or edited.
 * Composio's client is a fake; answers follow the shapes of Composio's output schemas.
 */
type Result = { data?: unknown; error?: string | null; successful: boolean };
type Answer = Result | ((args: Record<string, unknown>) => Result);
let calls: { slug: string; args: Record<string, unknown> }[];
let answers: Record<string, Answer>;

function fake(): ComposioClient {
  return {
    connectedAccounts: {
      link: async () => ({ id: "ca_new", redirectUrl: "https://connect.composio.dev/link/lk_1" }),
      waitForConnection: async (id) => ({ id, status: "ACTIVE" }),
      list: async () => ({ items: [] }),
      revoke: async () => {},
      delete: async () => {},
    },
    tools: {
      execute: async (slug, body) => {
        calls.push({ slug, args: body.arguments });
        const a = answers[slug];
        if (typeof a === "function") return a(body.arguments);
        return a ?? { successful: false, error: "not mocked" };
      },
    },
    files: { upload: async () => ({}) },
  };
}

beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "meta,linkedin");
  setComposioClientForTests(fake());
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); });

const ok = (data: unknown): Result => ({ successful: true, data });
const via = (provider: string, data: Record<string, string>, meta: Record<string, string> = {}): Connection => ({ provider, data, meta: { via: "composio", ...meta }, connectedAt: new Date().toISOString() });
void ok; void via;

const NEW_READS = {
  instagram: ["INSTAGRAM_GET_USER_INSIGHTS", "INSTAGRAM_GET_IG_USER_MEDIA", "INSTAGRAM_GET_IG_MEDIA_INSIGHTS"],
  linkedin: ["LINKEDIN_GET_COMPANY_INFO", "LINKEDIN_GET_SHARE_STATS", "LINKEDIN_GET_NETWORK_SIZE"],
} as const;

describe("social results are reads only (rule 661)", () => {
  it("lists each new tool as a read and never as a write", () => {
    for (const [tk, slugs] of Object.entries(NEW_READS)) for (const s of slugs) {
      expect(Object.keys(TOOLKITS[tk as Toolkit].read)).toContain(s);
      for (const t of Object.values(TOOLKITS)) expect(Object.keys(t.write)).not.toContain(s);
    }
  });
  it("refuses a new read slug through composioWrite", async () => {
    await expect(composioWrite("s1", "instagram", "INSTAGRAM_GET_IG_USER_MEDIA", { ig_user_id: "1" }, "ca_1")).rejects.toThrow("composio_tool_not_allowed");
    expect(calls).toEqual([]);
  });
});
