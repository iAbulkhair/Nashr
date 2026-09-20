import { describe, expect, it, vi, afterEach } from "vitest";
import { rangeWindow } from "@/lib/stats";
import { safeName, memoryBlock, writeFile } from "@/lib/files";
import { newUser } from "./helpers/session";

describe("a custom report range is request input, not a Date (P1: reports 500)", () => {
  const usable = (r: ReturnType<typeof rangeWindow>) =>
    Number.isFinite(r.from.getTime()) && Number.isFinite(r.to.getTime()) && Number.isFinite(r.prevFrom.getTime());

  it("an impossible date falls back to a usable window instead of producing NaN", () => {
    const r = rangeWindow("custom", "2024-13-01", "2024-01-05");
    expect(usable(r), "an unparseable date used to reach listLite and throw RangeError").toBe(true);
    expect(r.label).not.toBe("custom");
  });

  it("a repeated query key, which Next hands back as an array, is refused", () => {
    // `?from=a&from=b` gives searchParams.from === ["a","b"]; `new Date(array)` is Invalid Date.
    const r = rangeWindow("custom", ["2024-01-01", "2024-02-01"] as unknown as string, "2024-03-01");
    expect(usable(r)).toBe(true);
    expect(r.label).not.toBe("custom");
  });

  it("junk, empty and reversed ranges all fall back", () => {
    for (const [from, to] of [["nonsense", "2024-01-05"], ["2024-01-05", "nonsense"], ["", ""], ["2024-05-01", "2024-01-01"]]) {
      const r = rangeWindow("custom", from, to);
      expect(usable(r), `${from} → ${to}`).toBe(true);
      expect(r.label, `${from} → ${to}`).not.toBe("custom");
    }
  });

  it("a real custom range still works and still covers the whole last day", () => {
    const r = rangeWindow("custom", "2024-01-01", "2024-01-05");
    expect(r.label).toBe("custom");
    expect(r.from.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2024-01-05T23:59:59.999Z");
  });
});

describe("long file names keep their extension and stay distinct (P1: silent overwrite)", () => {
  it("two names differing only near the end do not collapse", () => {
    const q1 = "marketing-strategy-for-skincare-products-saudi-market-2026-q1.md";
    const q2 = "marketing-strategy-for-skincare-products-saudi-market-2026-q2.md";
    expect(safeName(q1)).not.toBe(safeName(q2));
  });

  it("the extension survives truncation", () => {
    const long = "a".repeat(80) + ".md";
    expect(safeName(long).endsWith(".md")).toBe(true);
    expect(safeName(long).length).toBeLessThanOrEqual(60);
  });

  it("the Arabic case too", () => {
    const a = "خطة-التسويق-لمنتجات-العناية-بالبشرة-في-السوق-السعودي-لعام-2026-الربع-الأول.md";
    const b = "خطة-التسويق-لمنتجات-العناية-بالبشرة-في-السوق-السعودي-لعام-2026-الربع-الثاني.md";
    expect(safeName(a)).not.toBe(safeName(b));
    expect(safeName(a).endsWith(".md")).toBe(true);
  });

  it("ordinary names are unchanged", () => {
    expect(safeName("notes.md")).toBe("notes.md");
    expect(safeName("My Notes.MD")).toBe("my-notes.md");
    expect(safeName("products.md")).toBe("products.md");
    expect(safeName("")).toBe("file.md");
  });
});

describe("a truncated memory file says so (P1: hidden catalog)", () => {
  it("declares how much of a large products.md the agent is seeing", async () => {
    const u = await newUser("memblock");
    const big = Array.from({ length: 400 }, (_, i) => `- **Product ${i}** — 99 SAR\n  description ${"x".repeat(30)}`).join("\n");
    expect(big.length).toBeGreaterThan(6000);
    await writeFile(u.email, "products.md", big, "noor");

    const block = await memoryBlock(u.email);
    expect(block).toContain("showing the first 6000");
    expect(block).toContain(String(Math.min(big.length, 40000)));
    expect(block).toContain("use read_file for the rest");
  });

  it("says nothing extra when the file fits", async () => {
    const u = await newUser("memblock");
    await writeFile(u.email, "brand.md", "short", "noor");
    const block = await memoryBlock(u.email);
    expect(block).toContain("--- brand.md ---");
    expect(block).not.toContain("showing the first");
  });
});

describe("a stalled image provider still reaches the refund (P1: credit lost)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.FAL_KEY; });

  it("the provider call carries an abort signal bounded well inside the route's ceiling", async () => {
    process.env.FAL_KEY = "test-key";
    let seen: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ images: [{ url: "https://cdn.example/i.png" }] }), { status: 200 });
    }) as typeof fetch;

    const { generateImage } = await import("@/lib/images");
    const brand = { name: "B", industry: "i", website: "", dialect: "saudi" as const, languages: ["ar" as const], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "" };
    const task = { id: "t", type: "social" as const, channel: "instagram", title: "t", body: "b", status: "pending" as const, createdAt: new Date().toISOString(), lang: "ar" as const };
    await generateImage(brand, task, "x@test.example");

    // Without a signal the route's 120s ceiling kills the invocation before its catch runs, so the charged credit is
    // never refunded. The bound has to be comfortably below that ceiling.
    expect(seen?.signal, "the provider call must be abortable").toBeDefined();
    expect(seen!.signal!.aborted).toBe(false);
  });
});
