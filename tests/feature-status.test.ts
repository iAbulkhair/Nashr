import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { customerFeatures } from "@/lib/feature-status";
import { integrationNames } from "@/lib/integration-status";
import FeatureStatus from "@/components/app/FeatureStatus";

/**
 * Rules 2450-2452: the customer's "What Thakeen has switched on" card (src/lib/feature-status.ts). On only when the
 * founder page would call the service on with no code switch holding it off; no variable name ever reaches it.
 */
const on = (env: Record<string, string>, paused = false) => Object.fromEntries(customerFeatures(env, paused).map((f) => [f.id, f.on]));
const FULL = {
  ANTHROPIC_API_KEY: "x", FAL_KEY: "x", KIE_API_KEY: "x", MEDIA_DIR: "/m", MEDIA_MODELS_ON: "x", RESEND_API_KEY: "x", MAIL_FROM: "x",
  PAYMOB_SECRET_KEY: "x", PAYMOB_PUBLIC_KEY: "x", PAYMOB_HMAC_SECRET: "x", PAYMOB_INTEGRATION_ID_CARD: "x", PAYMOB_LIVE: "x", COMPOSIO_API_KEY: "x", COMPOSIO_PROVIDERS: "x",
};

describe("rule 2450: each feature is on only when its service is set up and no code switch keeps it off", () => {
  it("all set: every feature on; nothing set: every feature off", () => {
    expect(Object.values(on(FULL)).every(Boolean)).toBe(true);
    expect(Object.values(on({})).some(Boolean)).toBe(false);
  });

  it("the code switches count: a paused model, media models not listed, Paymob test keys only", () => {
    expect(on(FULL, true).agents).toBe(false);
    expect(on({ ...FULL, MEDIA_MODELS_ON: "" }).media).toBe(false);
    expect(on({ ...FULL, PAYMOB_LIVE: "" }).card).toBe(false);
    expect(on({ ...FULL, MAIL_FROM: "" }).email, "half set is off").toBe(false);
    expect(on({ ...FULL, ANTHROPIC_API_KEY: "", STRAITLY_API_KEY: "x", LLM_PROVIDER: "straitly" }).agents, "the gateway alone runs the team").toBe(true);
  });
});

describe("rule 2451: the Connections page shows the card, text badges and both languages", () => {
  it("renders each feature with a text badge, and the page includes it", async () => {
    for (const lang of ["ar", "en"] as const) {
      const html = await new Response(await renderToReadableStream(createElement(FeatureStatus, { lang, features: customerFeatures({ FAL_KEY: "x" }, false) }))).text();
      expect(html).toContain(lang === "ar" ? "ما فعّله ذكين الآن" : "What Thakeen has switched on");
      expect(html).toContain('data-feature="images" data-on="1"');
      expect(html).toContain('data-feature="email" data-on="0"');
      expect(html).toContain(lang === "ar" ? "لم يُفعَّل بعد" : "Not on yet");
    }
    expect(readFileSync("src/app/[lang]/app/settings/connections/page.tsx", "utf8")).toContain("<FeatureStatus lang={lang} features={customerFeatures()} />");
  });
});

describe("rule 2452: no variable name reaches a customer", () => {
  it("the features and the card carry none of the names the founder page lists", async () => {
    const out = JSON.stringify(customerFeatures(FULL, false)) + (await new Response(await renderToReadableStream(createElement(FeatureStatus, { lang: "en", features: customerFeatures(FULL, false) }))).text());
    for (const n of integrationNames()) expect(out, n).not.toContain(n);
  });
});
