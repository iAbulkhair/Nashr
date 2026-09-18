import { describe, expect, it } from "vitest";
import { render } from "@/lib/md";
import { csvSafe } from "@/lib/admin-stats";
import { parseObjectArray } from "@/lib/json";

describe("Markdown renderer", () => {
  it("never lets a link break out of its href attribute", () => {
    const html = render('[click](https://x.example" onmouseover="alert(1) x=")');
    expect(html).not.toMatch(/href="[^"]*"\s+onmouseover=/);
    expect(html).toContain("&quot;");
  });
  it("escapes raw tags from model or crawled text", () => {
    const html = render("hello <img src=x onerror=alert(1)> **bold**");
    expect(html).not.toContain("<img");
    expect(html).toContain("<strong>bold</strong>");
  });
  it("drops non-http link schemes", () => expect(render("[x](javascript:alert(1))")).toContain('href="#"'));
});

describe("csvSafe", () => {
  it("neutralises formula cells", () => {
    for (const v of ["=HYPERLINK(1)", "+SUM(A1)", "-x", "@cmd", "+1+1"]) expect(csvSafe(v).startsWith("'")).toBe(true);
  });
  it("leaves phone numbers, negative numbers and names alone", () => {
    for (const v of ["+966500000000", "-5", "Ahmad", "0501234567"]) expect(csvSafe(v)).toBe(v);
  });
});

describe("parseObjectArray", () => {
  it("reads a plain array, a fenced array and a single object", () => {
    expect(parseObjectArray('[{"a":1},{"a":2}]')).toHaveLength(2);
    expect(parseObjectArray('```json\n[{"a":1}]\n```')).toHaveLength(1);
    expect(parseObjectArray('{"completeness":90,"notes":"ready"}')).toHaveLength(1);
  });
  // Regression: a lone object whose notes contain a bracketed placeholder used to be sliced as "[رقم]" and crash the judge.
  it("is not fooled by bracketed placeholders in the text", () => {
    expect(parseObjectArray('{"score":80,"notes":"ضع [رقم] هنا"}')[0].score).toBe(80);
    expect(parseObjectArray('Note [x]. [ {"ok":true} ]')[0].ok).toBe(true);
  });
  it("throws when there is no JSON at all", () => expect(() => parseObjectArray("no json here")).toThrow());
});
