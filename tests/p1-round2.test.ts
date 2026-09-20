import { describe, expect, it, vi, afterEach } from "vitest";
import { rangeWindow } from "@/lib/stats";
import { safeName, memoryBlock, writeFile, readFile, listFiles } from "@/lib/files";
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

describe("the agent cannot destroy an owner-written file (P1: curated products.md lost)", () => {
  it("an agent write over an owner-written file goes to a sibling, and the caller learns the real name", async () => {
    const u = await newUser("filesafe");

    await writeFile(u.email, "products.md", "12 hero SKUs, real margins, do not promote X", "user");
    const written = await writeFile(u.email, "products.md", "# scraped catalog\n- thing", "noor");

    expect(written.name, "the agent's write must not take the owner's name").toBe("products-imported.md");
    expect((await readFile(u.email, "products.md"))!.content).toContain("do not promote X");
    expect((await readFile(u.email, "products-imported.md"))!.content).toContain("scraped catalog");
    expect((await listFiles(u.email)).map((f) => f.name).sort()).toEqual(["products-imported.md", "products.md"]);
  });

  it("the agent still owns the files it wrote itself", async () => {
    const u = await newUser("filesafe");
    await writeFile(u.email, "market-research.md", "v1", "noor");
    const second = await writeFile(u.email, "market-research.md", "v2", "noor");
    expect(second.name).toBe("market-research.md");
    expect((await readFile(u.email, "market-research.md"))!.content).toBe("v2");
  });

  it("the owner can still overwrite their own file", async () => {
    const u = await newUser("filesafe");
    await writeFile(u.email, "notes.md", "first", "user");
    const again = await writeFile(u.email, "notes.md", "second", "user");
    expect(again.name).toBe("notes.md");
    expect((await readFile(u.email, "notes.md"))!.content).toBe("second");
  });
});

describe("a deck slide keeps its table (P1: numbers dropped from the export)", () => {
  it("table rows survive as bullets instead of vanishing", async () => {
    const { parseSlides } = await import("@/app/api/tasks/[id]/pptx/route");
    const body = [
      "## Slide 3: Scorecard",
      "| Metric | Target | Actual |",
      "|---|---|---|",
      "| Revenue | 100k | 92k |",
      "| Approvals | 40 | 51 |",
    ].join("\n");
    const slides = parseSlides(body, "Deck");
    const bullets = slides.flatMap((s) => s.bullets);
    expect(bullets.join(" ")).toContain("92k");
    expect(bullets.join(" ")).toContain("51");
    // The separator row carries nothing and must not become a bullet.
    expect(bullets.some((b) => /^[-|: ]+$/.test(b))).toBe(false);
  });
});
