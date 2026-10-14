"use client";
import { useEffect, useState } from "react";
import Scribble from "@/components/Scribble";
import { dateFormat } from "@/lib/dates";
import type { Lang } from "@/lib/i18n";
import { RIBBON, daysLeft, nextSeason, type NextSeason } from "@/lib/season-ribbon";
import styles from "./home.module.css";

/**
 * The next Gulf season, on a hand-drawn ribbon (rule 1880). The page is built ahead of time, so the count is made in
 * the visitor's browser, on the Riyadh calendar; until then the ribbon keeps its room empty and the layout does not
 * move. While the weekly plan is paused (`paused`) the ribbon names the season only and promises nothing about it.
 */
export default function SeasonRibbon({ lang, paused }: { lang: Lang; paused: boolean }) {
  const [next, setNext] = useState<NextSeason | null>(null);
  useEffect(() => {
    try {
      const f = dateFormat("en", { calendar: "islamic-umalqura", month: "numeric", day: "numeric" });
      const hijriOf = (d: Date) => {
        const p = f.formatToParts(d);
        return { m: Number(p.find((x) => x.type === "month")?.value), day: Number(p.find((x) => x.type === "day")?.value) };
      };
      setNext(nextSeason(new Date(), hijriOf));
    } catch {
      // A browser without the Umm al-Qura calendar shows no ribbon rather than a wrong date.
    }
  }, []);
  return (
    <p className={styles.ribbonRow} aria-live="off">
      {next && (
        <span className={`s-tape ${styles.ribbon}`}>
          <Scribble kind="tape" seed="season" fill="lemon" />
          <svg className={styles.cal} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4.5 6.5 C9 6 15 6.2 19.6 6.4 L19.2 19.6 C14 19.9 9 19.8 4.6 19.4 Z M4.6 10.4 C9.5 10.1 14.5 10.2 19.4 10.4 M8.4 4 L8.6 8.2 M15.6 3.8 L15.4 8.4" />
          </svg>
          <span>
            {RIBBON.lead[lang]} <b>{next.name[lang]}</b>{lang === "ar" ? "، " : ", "}{daysLeft(lang, next.days)}.{!paused && <> {RIBBON.tail[lang]}</>}
            {next.hijri && <small className={styles.ribbonNote}>{RIBBON.hijri[lang]}</small>}
          </span>
        </span>
      )}
    </p>
  );
}
