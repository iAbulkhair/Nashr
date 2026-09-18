import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests run against the in-memory store in src/lib/db.ts: no Redis, no network, no model calls.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
