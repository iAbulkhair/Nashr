import { NextResponse } from "next/server";
import PptxGenJS from "pptxgenjs";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask } from "@/lib/brand";

export const maxDuration = 60;

type Slide = { title: string; bullets: string[]; notes: string };

/** Parse Dana's deck outline ("## Slide N: Title" + "- bullets" + "Notes: ...") or any Markdown into slides. */
export function parseSlides(md: string, fallbackTitle: string): Slide[] {
  const lines = md.replace(/\r/g, "").split("\n");
  const slides: Slide[] = [];
  let cur: Slide | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const h = line.match(/^#{1,3}\s*(?:Slide\s*\d+\s*[:：.-]\s*|الشريحة\s*\d+\s*[:：.-]\s*)?(.+)$/i);
    if (h && /^#{1,3}\s/.test(line)) {
      cur = { title: h[1].trim(), bullets: [], notes: "" };
      slides.push(cur);
      continue;
    }
    if (!cur) { cur = { title: fallbackTitle, bullets: [], notes: "" }; slides.push(cur); }
    const n = line.match(/^(?:Notes?|Speaker notes?|ملاحظات(?: المتحدث)?)\s*[:：]\s*(.*)$/i);
    if (n) { cur.notes = (cur.notes ? cur.notes + " " : "") + n[1]; continue; }
    const b = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (b) { cur.bullets.push(b[1].replace(/\*\*/g, "")); continue; }
    if (line && !line.startsWith("|") && !line.startsWith("---")) cur.bullets.push(line.replace(/\*\*/g, ""));
  }
  return slides.filter((s) => s.title || s.bullets.length).slice(0, 30);
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const [t, brand] = await Promise.all([getTask(sc(u), id), getBrand(sc(u))]);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const ar = t.lang === "ar";
  const slides = parseSlides(t.editedBody ?? t.body, t.title);

  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_16x9";
  pres.rtlMode = ar;
  pres.title = t.title;
  pres.author = "Nashr";
  const font = ar ? "Arial" : "Calibri";
  const common = { fontFace: font, rtlMode: ar, lang: ar ? "ar-SA" : "en-US" } as const;

  // Cover
  const cover = pres.addSlide();
  cover.background = { color: "0F3D3A" };
  cover.addText(brand?.name ?? "Nashr", { x: 0.6, y: 1.4, w: 8.8, h: 1.2, fontSize: 40, bold: true, color: "F2B33D", align: ar ? "right" : "left", ...common });
  cover.addText(t.title, { x: 0.6, y: 2.7, w: 8.8, h: 0.9, fontSize: 22, color: "E9F0EC", align: ar ? "right" : "left", ...common });
  cover.addText(new Date().toISOString().slice(0, 10), { x: 0.6, y: 4.6, w: 8.8, h: 0.4, fontSize: 12, color: "A9BFB8", align: ar ? "right" : "left", ...common });

  for (const s of slides) {
    const sl = pres.addSlide();
    sl.background = { color: "F6F4EE" };
    sl.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.12, fill: { color: "D9503F" } });
    sl.addText(s.title, { x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 26, bold: true, color: "0F3D3A", align: ar ? "right" : "left", ...common });
    const items = s.bullets.length ? s.bullets : ["…"];
    sl.addText(items.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })), { x: 0.6, y: 1.35, w: 8.8, h: 3.6, fontSize: items.length > 6 ? 13 : 16, color: "101418", valign: "top", align: ar ? "right" : "left", paraSpaceAfter: 6, ...common });
    if (s.notes) sl.addNotes(s.notes);
    sl.addText("Nashr · نشر", { x: 0.5, y: 5.15, w: 9, h: 0.3, fontSize: 9, color: "A9BFB8", align: ar ? "left" : "right", ...common });
  }

  const buf = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  const name = `${(brand?.name ?? "nashr").replace(/[^\w؀-ۿ-]+/g, "_")}-${t.type}-${t.id}.pptx`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
