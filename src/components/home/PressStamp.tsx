"use client";
import { useState } from "react";
import Scribble from "@/components/Scribble";
import styles from "./home.module.css";

/**
 * The owner's one word as a stamp the visitor presses (rule 1881): a toggle button (`aria-pressed`) that starts as a
 * paper stamp held over the page and, pressed, lands in lemon. The landing thump runs only when motion is allowed (the
 * page's pause switch and `prefers-reduced-motion`, home.module.css); otherwise the stamp simply changes colour. It
 * records nothing and sends nothing: it is the page showing what approving feels like.
 */
export default function PressStamp({ label }: { label: string }) {
  const [on, setOn] = useState(false);
  return (
    <button type="button" className={`s-stamp ${styles.bigstamp} ${styles.press}`} aria-pressed={on} data-on={on ? "" : undefined} onClick={() => setOn((v) => !v)}>
      <Scribble kind="stamp" seed="d4stamp" fill={on ? "lemon" : "paper"} />
      {label}
    </button>
  );
}
