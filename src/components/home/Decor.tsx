import type { CSSProperties, ReactNode } from "react";
import { CAST } from "@/lib/home";
import styles from "./home.module.css";

/*
 * Prototype D's decoration: small hand-drawn doodles floating in the margins of a section, and the seams between
 * sections (a paper plane on its dashed trail, the team's colours hopping in a wave with «you» last, an ink line that
 * writes itself). All of it is hidden from assistive technology and drawn at rest; it moves only under
 * `prefers-reduced-motion: no-preference` and stops when the page's pause button sets `html[data-motion="off"]`
 * (`./motion`). Server components: CSS does the moving. Each moving piece carries `data-loop`, and `LoopPause` holds
 * its endless animations while it is off screen (rule 1868), so a long page does not keep painting what nobody sees.
 */

const f = (fill: string) => ({ "--f": fill }) as CSSProperties;
const PLANE = (
  <>
    <path className={styles.ff} style={f("color-mix(in oklab, var(--color-agent-faris) 30%, transparent)")} d="M4 23 L44 6 L34 41 Z" />
    <path className={styles.fi} d="M4.2 23.2 L44 6 L34.6 41 L23.6 29 Z M23.6 29 L43.6 6.4 M23.6 29 L21.6 39.6 L27.6 33.6" />
  </>
);

const FLOATS = {
  star: (
    <>
      <path className={styles.ff} style={f("var(--color-lemon)")} d="M24 4.5 L29.6 17.2 L43.4 18.4 L33 27.6 L36.2 41.2 L24.2 34 L12 41.4 L15.2 27.6 L4.8 18.6 L18.6 17.2 Z" />
      <path className={styles.fi} d="M24.2 4 L29.4 17.6 L43.8 18 L32.6 28 L36.6 41.6 L24 34.4 L11.6 41 L15.6 27.4 L4.4 18.8 L18.8 16.8 Z" />
    </>
  ),
  q: (
    <>
      <path className={styles.ff} style={f("var(--color-lemon)")} d="M24 6 C34 5 41 12 40 22 C40 32 33 41 23 40 C13 40 7 33 8 23 C8 13 14 7 24 6 Z" />
      <path className={styles.fi} d="M16.5 17 C16.5 10.5 21 7.5 25.5 7.8 C31 8.2 33.5 12.5 32.5 16.8 C31.6 20.6 27.6 22 25.6 25.4 C24.8 26.8 24.7 28.5 24.8 30.6" />
      <circle className={styles.fd} cx="24.9" cy="37" r="2" />
    </>
  ),
  cup: (
    <>
      <path className={styles.ff} style={f("var(--color-agent-reem)")} d="M10 22 L38 22 C37 33 31.5 39.5 24 39.5 C16.5 39.5 11 33 10 22 Z" />
      <path className={styles.fi} d="M10.2 22.4 L38 21.8 C37.2 33.2 31.4 39.8 24 39.6 C16.4 39.6 10.8 33 10.2 22.4 Z M11.6 27.4 C20 28.8 28 28.6 36.6 27 M6 42.6 C16 45.6 32 45.4 42 42.4 M19 17 C16.5 13.5 21 11 18.5 6.5 M27.5 17 C25 13.5 29.5 11 27 6.5" />
    </>
  ),
  plane: (
    <>
      {PLANE}
      <path className={`${styles.fi} ${styles.fdash}`} d="M2 38 C5 40.5 9 40 11 35.5" />
    </>
  ),
  cloud: (
    <>
      <path className={styles.ff} style={f("color-mix(in oklab, var(--color-agent-dana) 40%, transparent)")} d="M13 35 C7 35 4.5 30.5 6 26.5 C7 22.5 11 21 14 22 C14 15 19.5 11 25.5 11.5 C31 12 34.5 16 34.5 20 C38.5 18 43.5 20.5 43.5 26 C43.5 31 39.5 35 35 35 Z" />
      <path className={styles.fi} d="M13.2 35.2 C7.2 35 4.6 30.4 6.2 26.4 C7.4 22.4 11 21.2 14.2 22.2 C13.8 15 19.6 11 25.6 11.6 C31.2 12.2 34.6 16.2 34.4 20.2 C38.6 17.8 43.6 20.6 43.4 26.2 C43.4 31.2 39.4 35.2 34.8 35 Z" />
    </>
  ),
  spark: (
    <>
      <path className={styles.ff} style={f("var(--color-agent-razan)")} d="M24 3 C25 15 29 21 45 24 C29 26.5 25.5 31 24 45 C22.8 31 19 26.5 3 24 C19 21.5 23 15 24 3 Z" />
      <path className={styles.fi} d="M24.3 3.4 C25.2 15.2 29.4 21.2 44.6 24.2 C29.2 26.8 25.4 31.4 23.8 44.6 C22.6 31.2 18.8 26.4 3.4 23.8 C18.8 21.2 23.2 15 24.3 3.4 Z M40 4.5 L40.4 11 M37 7.8 L43.4 7.6" />
    </>
  ),
  bubble: (
    <>
      <path className={styles.ff} style={f("var(--color-agent-sami)")} d="M7 9 C7 6 9.5 4 13 4 L36 4 C40 4 43 6 43 9.5 L43 25 C43 29 40 31 36 31 L21 31 L12 40 L13.5 31 L13 31 C9.5 31 7 29 7 25.5 Z" />
      <path className={styles.fi} d="M7.2 9.2 C7 6 9.6 4.2 13 4.2 L36.2 3.8 C40.2 4 43 6.2 42.8 9.6 L43.2 25 C43 29.2 40 31.2 36 31 L21.2 31.2 L12.2 40 L13.6 31.2 L13 31.2 C9.4 31 7 29 7.2 25.4 Z" />
      <circle className={styles.fd} cx="17" cy="17.6" r="1.8" />
      <circle className={styles.fd} cx="25" cy="17.4" r="1.8" />
      <circle className={styles.fd} cx="33" cy="17.6" r="1.8" />
    </>
  ),
} satisfies Record<string, ReactNode>;

/** One floating doodle, placed in its section's margin by `.fl-<kind>` in home.module.css. */
export function Float({ kind }: { kind: keyof typeof FLOATS }) {
  return (
    <span className={`${styles.fl} ${styles[`fl-${kind}`]}`} data-loop="" aria-hidden="true">
      <svg viewBox="0 0 48 48">{FLOATS[kind]}</svg>
    </span>
  );
}

const FLY = "M0 24 C90 8 170 34 260 20 S430 8 520 22 S700 36 790 18 S940 10 1000 22";
const INK = "M60 30 C140 28 200 22 260 26 C300 30 312 10 290 8 C268 6 262 34 300 34 C360 34 420 24 500 26 C560 28 600 34 640 22 C660 14 652 6 640 10 C626 16 640 34 680 32 C760 28 860 24 936 28";

/** The divider between two sections. `fly` takes its own pace so two planes on one page never fly in step. */
export function Seam({ kind, pace }: { kind: "fly" | "team" | "ink"; pace?: { t: string; d: string } }) {
  if (kind === "fly")
    return (
      <div className={`${styles.seam} ${styles.seamFly}`} data-loop="" aria-hidden="true" style={pace ? ({ "--ft": pace.t, "--fd": pace.d } as CSSProperties) : undefined}>
        <svg className={styles.seamLine} viewBox="0 0 1000 40" preserveAspectRatio="none">
          <path className={styles.fi} pathLength="1" d={FLY} />
        </svg>
        <span className={styles.plane}>
          <span>
            <svg viewBox="0 0 48 48">{PLANE}</svg>
          </span>
        </span>
      </div>
    );
  if (kind === "team")
    return (
      <div className={`${styles.seam} ${styles.seamTeam}`} data-loop="" aria-hidden="true">
        <svg className={styles.seamLine} viewBox="0 0 1000 8" preserveAspectRatio="none">
          <path className={styles.fi} d="M330 4 C440 2 560 6 670 3" />
        </svg>
        <span className={styles.dots}>
          {CAST.map((m, k) => (
            <i key={m.id} style={{ "--c": `var(--color-agent-${m.id})`, "--k": k } as CSSProperties} />
          ))}
        </span>
      </div>
    );
  return (
    <div className={`${styles.seam} ${styles.seamInk}`} data-loop="" aria-hidden="true">
      <svg className={styles.seamLine} viewBox="0 0 1000 48">
        <path className={styles.fi} pathLength="1" d={INK} />
      </svg>
    </div>
  );
}
