export type Slide = { title: string; bullets: string[]; notes: string };

/** How many bullets fit in the 3.6in body box at the smaller of the two font sizes used in the pptx route. */
const MAX_BULLETS = 8;

/**
 * Parse Dana's deck outline ("## Slide N: Title" + "- bullets" + "Notes: ...") or any Markdown into slides.
 *
 * Every heading depth starts a slide. Only #, ## and ### used to, so a deck written with #### or deeper never broke:
 * the heading line failed the bullet and table tests, fell through to the catch-all below and was pushed as a bullet
 * with its own "####" still attached. The whole outline landed on one slide, with the markdown showing.
 */
export function parseSlides(md: string, fallbackTitle: string): Slide[] {
  const lines = md.replace(/\r/g, "").split("\n");
  const slides: Slide[] = [];
  let cur: Slide | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s*(?:Slide\s*\d+\s*[:：.-]\s*|الشريحة\s*\d+\s*[:：.-]\s*)?(.+)$/i);
    if (h && /^#{1,6}\s/.test(line)) {
      cur = { title: h[1].trim(), bullets: [], notes: "" };
      slides.push(cur);
      continue;
    }
    if (!cur) { cur = { title: fallbackTitle, bullets: [], notes: "" }; slides.push(cur); }
    const n = line.match(/^(?:Notes?|Speaker notes?|ملاحظات(?: المتحدث)?)\s*[:：]\s*(.*)$/i);
    if (n) { cur.notes = (cur.notes ? cur.notes + " " : "") + n[1]; continue; }
    const b = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (b) { cur.bullets.push(b[1].replace(/\*\*/g, "")); continue; }
    if (line.startsWith("|")) {
      // A deck slide is often a scorecard, and the reporting playbook teaches the model to write those as markdown
      // tables. Dropping every pipe line exported the slide with all of its numbers gone. Flatten each row instead;
      // the separator row (|---|---|) carries nothing.
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length && !cells.every((c) => /^:?-+:?$/.test(c))) cur.bullets.push(cells.join(" · ").replace(/\*\*/g, ""));
      continue;
    }
    if (line && !line.startsWith("---")) cur.bullets.push(line.replace(/\*\*/g, ""));
  }
  // A slide holds what fits on it. The text box is a fixed 3.6 inches tall, so a section that ran long used to print
  // past the bottom edge of the slide and out of the deck. Overflow continues onto a numbered sibling instead.
  const out: Slide[] = [];
  for (const s of slides.filter((x) => x.title || x.bullets.length)) {
    if (s.bullets.length <= MAX_BULLETS) { out.push(s); continue; }
    for (let i = 0; i < s.bullets.length; i += MAX_BULLETS) {
      const part = i / MAX_BULLETS + 1;
      out.push({ title: part === 1 ? s.title : `${s.title} (${part})`, bullets: s.bullets.slice(i, i + MAX_BULLETS), notes: part === 1 ? s.notes : "" });
    }
  }
  return out.slice(0, 30);
}
