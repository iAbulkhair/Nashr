import { vi } from "vitest";

/**
 * Claude is paused in code (src/lib/model.ts). A test that drives the real model path against a mocked SDK switches
 * it on for the modules it imports after this call. Pair it with vi.resetModules() and vi.doUnmock("@/lib/model").
 */
export function claudeOn() {
  vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
}
