import Scribble from "@/components/Scribble";
import type { CastId } from "@/lib/home";
import Doodle from "./Doodle";
import styles from "./home.module.css";

/** A cast member's face in a hand-drawn loop of their colour (prototype D's `.face`). Decoration: the name sits beside it. */
export default function Face({ who, seed, small }: { who: CastId; seed: string; small?: boolean }) {
  return (
    <span className={small ? `${styles.dface} ${styles.dfaceSm}` : styles.dface} aria-hidden="true">
      <Scribble kind="circleLoop" seed={seed} fill={who === "you" ? "paper" : `agent-${who}`} />
      <i>
        <Doodle who={who} crop="face" />
      </i>
    </span>
  );
}
