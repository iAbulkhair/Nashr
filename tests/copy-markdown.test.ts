import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CopyMarkdownButton from "@/components/CopyMarkdownButton";
import { copyMarkdown, fetchMarkdown, type ClipboardEnv } from "@/lib/copy-markdown";

/**
 * Rule 3317: a post and a help topic have a "Copy page as Markdown" button. It fetches the page's own Markdown copy (rule
 * 3316) when pressed, copies it by the best way the browser allows, says the result in Arabic or English, is a real button,
 * and where nothing can copy it points to the file. There is no DOM in this suite, so the copying logic is tested through
 * fakes and the component through its server markup.
 */
const TEXT = "# Title\n\nBody\n";
const blobText = async (b: Blob) => b.text();

/** A clipboard item that remembers what it was given. */
class FakeItem {
  constructor(public items: Record<string, Promise<Blob>>) {}
}

describe("rule 3317: fetching the copy", () => {
  it("asks for the file without cookies and returns its text", async () => {
    const fetcher = vi.fn(async () => new Response(TEXT, { status: 200 })) as unknown as typeof fetch;
    expect(await fetchMarkdown("/en/blog/x.md", fetcher)).toBe(TEXT);
    expect(fetcher).toHaveBeenCalledWith("/en/blog/x.md", { credentials: "omit", headers: { Accept: "text/markdown" } });
  });
  it("throws for a page that is not there, so nothing wrong is copied", async () => {
    const fetcher = (async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchMarkdown("/en/blog/nope.md", fetcher)).rejects.toThrow(/404/);
  });
});

describe("rule 3317: copying", () => {
  it("writes a clipboard item holding the pending text first (the form Safari allows after a click)", async () => {
    let written: FakeItem[] = [];
    const env: ClipboardEnv = { clipboard: { write: async (i) => { written = i as FakeItem[]; await Promise.all(Object.values(written[0].items)); } }, ClipboardItem: FakeItem };
    expect(await copyMarkdown(async () => TEXT, env)).toBe(true);
    expect(await blobText(await written[0].items["text/plain"])).toBe(TEXT);
  });
  it("falls back to writeText when the item form is refused, asking the network once", async () => {
    const ask = vi.fn(async () => TEXT);
    const writeText = vi.fn(async () => {});
    const env: ClipboardEnv = { clipboard: { write: async () => { throw new Error("NotAllowed"); }, writeText }, ClipboardItem: FakeItem };
    expect(await copyMarkdown(ask, env)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(TEXT);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it("uses writeText alone where there is no clipboard item type", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyMarkdown(async () => TEXT, { clipboard: { writeText } })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(TEXT);
  });
  const fakeDoc = (ok: boolean | "throws") => {
    const field = { value: "", style: { cssText: "" }, attrs: {} as Record<string, string>, selected: false, removed: false, setAttribute(k: string, v: string) { this.attrs[k] = v; }, select() { this.selected = true; }, remove() { this.removed = true; } };
    const doc = { createElement: () => field, body: { appendChild: vi.fn() }, execCommand: () => { if (ok === "throws") throw new Error("no"); return ok; } };
    return { doc: doc as unknown as ClipboardEnv["document"], field };
  };
  it("uses a hidden selected text field and removes it, where there is no clipboard API", async () => {
    const { doc, field } = fakeDoc(true);
    expect(await copyMarkdown(async () => TEXT, { document: doc })).toBe(true);
    expect(field.value).toBe(TEXT);
    expect(field.selected).toBe(true);
    expect(field.removed).toBe(true);
    expect(field.attrs["aria-hidden"]).toBe("true");
  });
  it("tries the field when writeText is refused", async () => {
    const { doc } = fakeDoc(true);
    expect(await copyMarkdown(async () => TEXT, { clipboard: { writeText: async () => { throw new Error("denied"); } }, document: doc })).toBe(true);
  });
  it("says it failed, and never throws, when nothing can copy or the text cannot be had", async () => {
    expect(await copyMarkdown(async () => TEXT, {})).toBe(false);
    const { doc, field } = fakeDoc(false);
    expect(await copyMarkdown(async () => TEXT, { document: doc })).toBe(false);
    expect(field.removed).toBe(true);
    expect(await copyMarkdown(async () => TEXT, { document: fakeDoc("throws").doc })).toBe(false);
    const unreachable = vi.fn(async () => { throw new Error("offline"); });
    const writeText = vi.fn(async () => {});
    expect(await copyMarkdown(unreachable, { clipboard: { writeText, write: async (i) => { await Promise.all(Object.values((i as FakeItem[])[0].items)); } }, ClipboardItem: FakeItem })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(unreachable).toHaveBeenCalledTimes(1);
  });
});

describe("rule 3317: the button", () => {
  const html = (lang: "ar" | "en") => renderToStaticMarkup(createElement(CopyMarkdownButton, { href: `/${lang}/blog/x.md`, lang }));
  it("is a real button named for what it does, in the page's language and direction", () => {
    const en = html("en");
    expect(en).toMatch(/<button type="button"[^>]*>/);
    expect(en).toContain("Copy page as Markdown");
    expect(en).toContain('dir="ltr"');
    const ar = html("ar");
    expect(ar).toContain("نسخ الصفحة بصيغة Markdown");
    expect(ar).toContain('dir="rtl"');
  });
  it("carries a polite status for the result, empty until there is one", () => {
    expect(html("en")).toMatch(/<span role="status" class="sr-only"><\/span>/);
  });
  it("offers the file itself without script, and shows no failure before one happens", () => {
    const en = html("en");
    expect(en).toMatch(/<noscript><a href="\/en\/blog\/x\.md"[^>]*>Open the Markdown file<\/a><\/noscript>/);
    expect(en).not.toContain("Could not copy");
    expect(en).not.toContain('target="_blank"');
  });
  it("is a client component with its own copy, and is placed on the post and the help topic with the page's copy address", () => {
    expect(readFileSync("src/components/CopyMarkdownButton.tsx", "utf8").startsWith('"use client";')).toBe(true);
    const blog = readFileSync("src/app/[lang]/blog/[slug]/page.tsx", "utf8");
    const help = readFileSync("src/app/[lang]/help/[topic]/page.tsx", "utf8");
    expect(blog).toContain("<CopyMarkdownButton lang={lang} href={`/${lang}/blog/${slug}.md`}");
    expect(help).toContain("<CopyMarkdownButton lang={lang} href={`/${lang}/help/${t.id}.md`}");
  });
  it("shows the failure link and the copied state in its source for both languages", () => {
    const src = readFileSync("src/components/CopyMarkdownButton.tsx", "utf8");
    for (const w of ["نُسخت الصفحة بصيغة Markdown", "Page copied as Markdown", "تعذّر النسخ.", "Could not copy."]) expect(src).toContain(w);
    expect(src).toMatch(/state === "failed" && \([\s\S]*<a href=\{href\}/);
  });
});
