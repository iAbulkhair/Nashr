/**
 * The hand-drawn pen of prototype D (`scribble.js`, rule 512), as pure functions: no DOM, so the server and the browser
 * draw the same path from the same seed. Same FNV-1a seed hash and generator as D, coordinates rounded to 0.1, and the
 * random numbers are drawn in D's order, so a seed gives D's line. Arrow, road and the hatch fill are left out: the
 * product draws none of them.
 */
export type ScribbleKind = "box" | "bubble" | "circleLoop" | "cloud" | "divider" | "pill" | "puddle" | "stamp" | "strike" | "swash" | "tape" | "tick" | "underline";
export type ScribbleOpts = { tail?: "bottom" | "start" | "end" | "none"; tailAt?: number; rtl?: boolean; heavy?: boolean };
/**
 * `d` is the inked line ("" for the swash and the divider, which draw none); `fill` the area behind it; `cap`/`capFill`
 * a speech tail; `ink` a filled stroke (the divider); `ghost` a second, lighter line; `still` means the fill is not
 * offset like a misregistered print.
 */
export type ScribbleArt = { d: string; fill?: string; cap?: string; capFill?: string; ink?: string; ghost?: string; still?: boolean };

type Pt = [number, number];
/** A point on an outline at parameter 0-1 with the outward normal: [x, y, nx, ny]; `P` is the perimeter. */
type Outline = ((t: number) => [number, number, number, number]) & { P: number };
type Rng = (() => number) & { u: (a: number, b: number) => number; j: (a: number) => number };

const { hypot, cos, sin, max, min, round, PI } = Math;
const TAU = 2 * PI;
const r1 = (n: number) => round(10 * n) / 10;
const pt = (p: Pt) => `${r1(p[0])} ${r1(p[1])}`;
const clamp = (n: number, lo: number, hi: number) => max(lo, min(hi, n));
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** FNV-1a of the seed, then D's 32-bit generator; `u(a, b)` is a number in [a, b), `j(a)` a jitter in (-a, a). */
export function seeded(seed: string): Rng {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let s = h >>> 0;
  const next = () => {
    s = (s + 1831565813) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, { u: (a: number, b: number) => a + (b - a) * next(), j: (a: number) => (2 * next() - 1) * a });
}

/** One pen stroke from a to b: overshoots both ends a little and bows to one side. */
function stroke(rng: Rng, a: Pt, b: Pt, over = 3.5): string {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, bow = clamp(1 + 0.01 * len, 1, 5);
  const o1 = rng.u(0.3, 1) * over, o2 = rng.u(0.3, 1) * over;
  const s: Pt = [a[0] - ux * o1, a[1] - uy * o1], e: Pt = [b[0] + ux * o2, b[1] + uy * o2];
  const b1 = (rng() < 0.5 ? -1 : 1) * rng.u(0.4, 1) * bow, b2 = rng.j(bow);
  const at = (t: number, off: number) => pt([s[0] + (e[0] - s[0]) * t - uy * off, s[1] + (e[1] - s[1]) * t + ux * off]);
  return `M${pt(s)}C${at(0.33, b1)} ${at(0.67, b2)} ${pt(e)}`;
}

/** A smooth curve through the points (Catmull-Rom as cubic Béziers), closed or open. */
function spline(p: Pt[], closed = false): string {
  const n = p.length;
  let d = `M${pt(p[0])}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = p[closed ? (i - 1 + n) % n : max(i - 1, 0)], b = p[i], c = p[(i + 1) % n], e = p[closed ? (i + 2) % n : min(i + 2, n - 1)];
    d += `C${pt([b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6])} ${pt([c[0] - (e[0] - b[0]) / 6, c[1] - (e[1] - b[1]) / 6])} ${pt(c)}`;
  }
  return d + (closed ? "Z" : "");
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Outline {
  const f = (t: number): [number, number, number, number] => { const a = t * TAU - PI / 2, c = cos(a), s = sin(a); return [cx + rx * c, cy + ry * s, c, s]; };
  return Object.assign(f, { P: PI * (rx + ry) });
}

function roundRect(x: number, y: number, w: number, h: number, radius: number): Outline {
  const r = max(0, min(radius, w / 2, h / 2)), sw = w - 2 * r, sh = h - 2 * r, arc = (PI * r) / 2;
  const seg = [sw, arc, sh, arc, sw, arc, sh, arc];
  const corner: Pt[] = [[x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r]];
  const P = 2 * (sw + sh) + 4 * arc;
  const f = (t: number): [number, number, number, number] => {
    let o = (((t % 1) + 1) % 1) * P, s = 0;
    while (s < 7 && o > seg[s]) o -= seg[s++];
    o = min(o, seg[s]);
    const side = s >> 1;
    let a = (side * PI) / 2 - PI / 2;
    if (s & 1) {
      a += r ? o / r : 0;
      const c = corner[side];
      return [c[0] + r * cos(a), c[1] + r * sin(a), cos(a), sin(a)];
    }
    const c = corner[(side + 3) % 4], nx = cos(a), ny = sin(a);
    return [c[0] + r * nx - o * ny, c[1] + r * ny + o * nx, nx, ny];
  };
  return Object.assign(f, { P });
}

type Trace = { closed?: boolean; over?: number; drift?: number; wob?: number; t0?: number };
/** Walks an outline with a wobbling hand; an open line starts at t0, overshoots by `over` and drifts outward by `drift`. */
function trace(rng: Rng, shape: Outline, o: Trace): string {
  const steps = clamp(round(shape.P / 26), 10, 64), over = o.closed ? 0 : o.over ?? 0.05, drift = o.closed ? 0 : o.drift || 0, wob = o.wob ?? 1.4;
  const t0 = o.t0 ?? rng(), p1 = rng() * TAU, p2 = rng() * TAU, last = o.closed ? steps - 1 : Math.ceil(steps * (1 + over));
  const pts: Pt[] = [];
  for (let i = 0; i <= last; i++) {
    const t = i / steps, q = shape(t0 + t), off = wob * (0.6 * sin(p1 + t * TAU * 2) + 0.4 * sin(p2 + t * TAU * 3)) + drift * (t / (1 + over) - 0.5);
    pts.push([q[0] + q[2] * off, q[1] + q[3] * off]);
  }
  return spline(pts, o.closed);
}

/** Four corners of a rectangle, each nudged by up to `j`. */
function quad(rng: Rng, x: number, y: number, w: number, h: number, j: number): Pt[] {
  const p = (px: number, py: number): Pt => { const a = px + rng.j(j); return [a, py + rng.j(j)]; };
  return [p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h)];
}

/** A closed shape through the points whose sides bulge by up to `j`. */
function blob(rng: Rng, p: Pt[], j: number): string {
  let d = `M${pt(p[0])}`;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], dx = b[0] - a[0], dy = b[1] - a[1], len = hypot(dx, dy) || 1, k = rng.j(j);
    d += `Q${pt([(a[0] + b[0]) / 2 - (dy / len) * k, (a[1] + b[1]) / 2 + (dx / len) * k])} ${pt(b)}`;
  }
  return d + "Z";
}

/** Each side of a polygon as its own pen stroke. */
const sides = (rng: Rng, p: Pt[], over?: number) => p.map((a, i) => stroke(rng, a, p[(i + 1) % p.length], over)).join("");

const SHAPES: Record<ScribbleKind, (w: number, h: number, rng: Rng, o: ScribbleOpts) => ScribbleArt> = {
  box(w, h, rng, o) {
    const c = quad(rng, 0, 0, w, h, 1.5);
    let d = sides(rng, c);
    if (o.heavy) d += stroke(rng, [c[3][0] + 3, c[3][1] + 2.5], [c[2][0] - 3, c[2][1] + 2.5], 2);
    return { d, fill: blob(rng, quad(rng, 0, 0, w, h, 1.5), 2) };
  },
  pill(w, h, rng) {
    const s = roundRect(0, 0, w, h, h / 2);
    const d = trace(rng, s, { over: 0.03, drift: 3.5, t0: rng.u(0.3, 0.45) });
    return { d, fill: trace(rng, s, { closed: true, wob: 1 }) };
  },
  bubble(w, h, rng, o) {
    const s = roundRect(0, 0, w, h, min(18, h / 2.4)), tail = o.tail || "bottom", rtl = !!o.rtl;
    const d = trace(rng, s, { over: 0.03, drift: 3.5, t0: rng.u(0.05, 0.2) });
    const art: ScribbleArt = { d, fill: trace(rng, s, { closed: true, wob: 1 }) };
    if (tail === "none") return art;
    let a: Pt, b: Pt, ia: Pt, ib: Pt, tip: Pt;
    if (tail === "bottom") {
      const at = o.tailAt ?? 0.25, x = clamp(rtl ? w * (1 - at) : w * at, 22, w - 22), dir = rtl ? 1 : -1;
      [a, b, ia, ib] = [[x - 8, h], [x + 8, h], [x - 8, h - 5], [x + 8, h - 5]];
      tip = [x + 8 * dir + rng.j(2), h + 16];
    } else {
      const x = (tail === "start") === !rtl ? 0 : w, dir = x ? 1 : -1, y = clamp(0.62 * h, 10, h - 10);
      [a, b, ia, ib] = [[x, y - 7], [x, y + 7], [x - 5 * dir, y - 7], [x - 5 * dir, y + 7]];
      tip = [x + 16 * dir, y + 10 + rng.j(2)];
    }
    art.capFill = `M${[ia, a, tip, b, ib].map(pt).join("L")}Z`;
    art.cap = stroke(rng, a, tip, 1.5) + stroke(rng, b, tip, 1.5);
    return art;
  },
  cloud(w, h, rng, o) {
    const puff = clamp(0.16 * min(w, h), 6, 12), rx = w / 2 - puff, ry = h / 2 - puff, cx = w / 2, cy = h / 2, rtl = !!o.rtl;
    const n = clamp(round((PI * (rx + ry)) / 42), 7, 20), start = -2.5 + rng.j(0.08), tail = o.tail || "bottom";
    const ring: Pt[] = [];
    for (let i = 0; i <= n; i++) { const a = start + ((i + (i && i < n ? rng.j(0.18) : 0)) / n) * TAU; ring.push([cx + rx * cos(a), cy + ry * sin(a)]); }
    let d = `M${pt(ring[0])}`;
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[i + 1], mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, nx = (mx - cx) / (rx * rx), ny = (my - cy) / (ry * ry), nl = hypot(nx, ny) || 1;
      const bulge = 2 * min(puff, 0.42 * hypot(q[0] - p[0], q[1] - p[1])) * rng.u(0.85, 1.1);
      d += `Q${pt([mx + (nx / nl) * bulge, my + (ny / nl) * bulge])} ${pt(q)}`;
    }
    let from: Pt, dir: Pt;
    if (tail === "bottom") { const side = rtl ? 1 : -1; from = [cx + side * rx * 0.55, h - 0.2 * puff]; dir = [0.45 * side, 1]; }
    else { const side = (tail === "start") === !rtl ? -1 : 1; from = [side > 0 ? w - 0.2 * puff : 0.2 * puff, cy + 0.5 * ry]; dir = [side, 0.55]; }
    const dl = hypot(dir[0], dir[1]);
    let dots = "", dotFill = "";
    for (const [r, dist] of [[7, 11], [4.5, 24], [3, 34]]) {
      const e = ellipse(from[0] + (dir[0] / dl) * dist, from[1] + (dir[1] / dl) * dist, r, r);
      dots += trace(rng, e, { over: 0.15, drift: 1, wob: 0.4 });
      dotFill += trace(rng, e, { closed: true, wob: 0.3 });
    }
    return { d: d + dots, fill: d + "Z" + dotFill };
  },
  stamp(w, h, rng) {
    let d = sides(rng, quad(rng, 0, 0, w, h, 1.2), 2.5);
    const inner = quad(rng, 4, 4, w - 8, h - 8, 1);
    for (let i = 0; i < 4; i++) {
      const a = inner[i], b = inner[(i + 1) % 4];
      if (rng() < 0.45) {
        const s = rng.u(0.25, 0.65), gap = rng.u(5, 11) / (hypot(b[0] - a[0], b[1] - a[1]) || 1);
        d += stroke(rng, a, lerp(a, b, s), 0.6) + stroke(rng, lerp(a, b, s + gap), b, 0.6);
      } else d += stroke(rng, a, b, 0.8);
    }
    return { d, fill: blob(rng, quad(rng, 0, 0, w, h, 1), 1.5) };
  },
  tape(w, h, rng) {
    const p: Pt[] = [];
    for (let i = 0; i <= 4; i++) p.push([rng.j(1.5) + (i % 2 ? 3 : 0), h - (i * h) / 4]);
    p.push([w / 2 + rng.j(0.1 * w), rng.j(1)]);
    for (let i = 0; i <= 4; i++) p.push([w - (i % 2 ? 3 : 0) + rng.j(1.5), (i * h) / 4]);
    p.push([w / 2 + rng.j(0.1 * w), h + rng.j(1)]);
    const d = `M${p.map(pt).join("L")}Z`;
    return { d, fill: d, still: true };
  },
  circleLoop(w, h, rng) {
    const e = ellipse(w / 2, h / 2, w / 2, h / 2);
    const over = rng.u(0.08, 0.16), drift = clamp(0.08 * min(w, h), 2.5, 6), t0 = rng.u(0.78, 0.92);
    const d = trace(rng, e, { over, drift, t0, wob: 1.2 });
    return { d, fill: trace(rng, e, { closed: true, wob: 0.8 }) };
  },
  underline(w, h, rng, o) {
    const y = h - 2, a: Pt = [o.rtl ? w + 3 : -3, y + rng.j(1)], b: Pt = [o.rtl ? -4 : w + 4, y - rng.u(1, 3.5)];
    return { d: `M${pt(a)}Q${pt([w / 2 + rng.j(0.1 * w), y + rng.u(1, 3.5)])} ${pt(b)}` };
  },
  swash(w, h, rng) {
    const top = 0.45 * h, bottom = 0.95 * h;
    const p = (x: number, y: number, jy: number): Pt => { const a = x + rng.j(2); return [a, y + rng.j(jy)]; };
    return { d: "", fill: blob(rng, [p(-3, top, 2), p(w + 3, top, 3), p(w + 3, bottom, 2), p(-3, bottom, 2)], 2.5), still: true };
  },
  tick(w, h, rng) {
    const b = pt([0.22 * w + rng.j(2), 0.78 * h]), c = pt([0.38 * w + rng.j(1), 0.92 * h]), e = pt([0.6 * w + rng.j(3), 0.45 * h]);
    const fx = 0.95 * w + rng.j(1.5);
    return { d: `M${pt([0.08 * w, 0.55 * h])}Q${b} ${c}Q${e} ${pt([fx, 0.06 * h + rng.j(1.5)])}` };
  },
  strike(w, h, rng, o) {
    const n = max(3, round(w / 16)), amp = clamp(0.18 * h, 3, 8), y = 0.52 * h, p: Pt[] = [];
    for (let i = 0; i <= n; i++) { const x = ((w + 8) * i) / n - 4; p.push([o.rtl ? w - x : x, y + (i % 2 ? -amp : amp) * rng.u(0.7, 1.1) + rng.j(1)]); }
    return { d: `M${p.map(pt).join("L")}` };
  },
  puddle(w, h, rng) {
    const p: Pt[] = [];
    for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU + rng.j(0.2), k = rng.u(0.86, 1.06); p.push([w / 2 + ((cos(a) * w) / 2) * k, h / 2 + ((sin(a) * h) / 2) * k]); }
    return { d: spline(p.slice(0, 6)), fill: spline(p, true) };
  },
  divider(w, h, rng) {
    const n = max(6, round(w / 30)), mid = h / 2, thick = clamp(0.35 * h, 1.5, 3.2), top: Pt[] = [], bottom: Pt[] = [], phase = rng() * TAU;
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = mid + 1.6 * sin(phase + 5 * t) + rng.j(0.5), half = thick * Math.pow(sin(PI * t), 0.6) + 0.3;
      top.push([t * w, y - half]);
      bottom.unshift([t * w, y + half]);
    }
    return { d: "", ink: `${spline(top)}L${spline(bottom).slice(1)}Z`, ghost: stroke(rng, [0, mid + 2], [w, mid + 2], 4) };
  },
};

/** Draws `kind` in a w × h box. The same arguments always give the same art. */
export function scribble(kind: ScribbleKind, w: number, h: number, seed: string, opts: ScribbleOpts = {}): ScribbleArt {
  return SHAPES[kind](w, h, seeded(seed), opts);
}

/** The focus ring D draws round a scribbled control, 7px outside the box: the line, and a second fainter pass. */
export function scribbleRing(seed: string, kind: ScribbleKind, w: number, h: number): [string, string] {
  const rng = seeded(seed + "#"), r = kind === "pill" || kind === "circleLoop" ? h / 2 : min(12, h / 2);
  const draw = () => trace(rng, roundRect(-7, -7, w + 14, h + 14, r + 7), { over: 0.07, drift: 2, wob: 1.2 });
  return [draw(), draw()];
}
