import { describe, expect, it, vi } from "vitest";
import { json, newUser, signIn } from "./helpers/session";

/**
 * The brand's generation pick (`Brand.model`) is a setting only PUT /api/models writes (plan Task 6). Onboarding saves the
 * brand file the model built from the owner's site, so a `model` field in that output (a crawled page can steer what the
 * model writes) must never reach the saved file: the onboarding route strips it in code before `saveBrand`.
 */
vi.mock("@/lib/crawl", () => ({ crawl: async (url: string) => ({ url: `https://${url}`, ok: true, title: "Roastery | Home", description: "Coffee", text: "", links: [], platform: "unknown", colors: [], fonts: [] }) }));
vi.mock("@/lib/onboard", async (orig) => {
  const real = await orig<typeof import("@/lib/onboard")>();
  // The builder's own result (no model key: its mock path), with a pick added as if the model had written one.
  return { ...real, buildFromSite: async (...a: Parameters<typeof real.buildFromSite>) => { const r = await real.buildFromSite(...a); return { ...r, brand: { ...r.brand, model: "claude-opus-5" } }; } };
});

import { getBrand } from "@/lib/brand";
import * as onboardRoute from "@/app/api/onboard/route";
import * as confirmRoute from "@/app/api/onboard/confirm/route";

const drain = async (res: Response) => (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { type: string });

describe("onboarding never saves a model pick from the model's output", () => {
  it("a built brand holding model: claude-opus-5 is saved without it: the workspace starts on Automatic", async () => {
    const u = await newUser("onb-model");
    await signIn(u.email);
    expect((await confirmRoute.POST(json("/api/onboard/confirm", "POST", { url: "roastery.example" }))).status).toBe(200);
    const events = await drain(await onboardRoute.POST(json("/api/onboard", "POST", { url: "roastery.example" })));
    expect(events.at(-1)!.type).toBe("done");
    const saved = await getBrand(u.email);
    expect(saved).not.toBeNull();
    expect(saved!).not.toHaveProperty("model");
    expect(JSON.stringify(saved)).not.toContain("claude-opus-5");
  });
});
