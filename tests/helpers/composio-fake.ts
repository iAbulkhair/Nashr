import type { ComposioClient } from "@/lib/connectors/composio";

/**
 * A fake Composio client for the result readers' tests (moved from tests/composio-social.test.ts so the social, site
 * and ad reader tests share one). It records every tool call and answers from `answers` by slug, in the shapes of
 * Composio's output schemas; a slug with no answer fails as "not mocked". `owned` is what `connectedAccounts.list`
 * returns. The arrays and the map are the ones the client reads, so clear them in place (`calls.length = 0`), never
 * reassign them. Install with `setComposioClientForTests(f.client)`.
 */
export type Result = { data?: unknown; error?: string | null; successful: boolean };
export type Answer = Result | ((args: Record<string, unknown>) => Result);
export type Call = { slug: string; args: Record<string, unknown> };

export const ok = (data: unknown): Result => ({ successful: true, data });

export function fakeComposio(): { client: ComposioClient; calls: Call[]; answers: Record<string, Answer>; owned: string[] } {
  const calls: Call[] = [];
  const answers: Record<string, Answer> = {};
  const owned: string[] = [];
  const client: ComposioClient = {
    connectedAccounts: {
      link: async () => ({ id: "ca_new", redirectUrl: "https://connect.composio.dev/link/lk_1" }),
      waitForConnection: async (id) => ({ id, status: "ACTIVE" }),
      list: async () => ({ items: owned.map((id) => ({ id })) }),
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
  return { client, calls, answers, owned };
}
