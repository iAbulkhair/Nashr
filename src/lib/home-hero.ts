import { CHANGELOG, type ChangeEntry } from "./changelog";
import type { Lang } from "./i18n";

/**
 * The home cover's call to action and freshness chip (UI/UX phase 5b item 5, report §4.12 fixes 1 and 3; rules 1228,
 * 1229). The words live here, not in src/lib/home.ts, which release R1 (PR #322) owns.
 *
 * The call to action is the site's own signup form (`UrlStart`: an optional link to the owner's site, then the trial
 * button) with the trial line from the pricing copy under it, so every number on it comes from the pricing tables. No
 * price in the button (report §8 item 5).
 *
 * The chip's date is never typed by hand: it is the newest date in `CHANGELOG`, the feed the public updates page lists,
 * where every entry is a change merged into main and dated with its merge date. The page is prerendered, so the chip
 * shows the newest change in the build that is live. It names no change, so nothing on the cover promises a feature
 * that still waits on a setting.
 */

export type L = { ar: string; en: string };

/** The chip reads "<chip> <date>" and links to the updates page, so its name says where it goes. */
export const HERO_START: { chip: L } = {
  chip: { ar: "آخر تحديث للمنتج:", en: "Latest product update:" },
};

/** The newest dated entry in a changelog (the newest ISO date, whatever the order), or null when it is empty. */
export function latestChange(entries: readonly ChangeEntry[] = CHANGELOG): ChangeEntry | null {
  let best: ChangeEntry | null = null;
  for (const e of entries) if (/^\d{4}-\d{2}-\d{2}$/.test(e.date) && (!best || e.date > best.date)) best = e;
  return best;
}

/** Every visible string the cover's new parts own, both languages (rule 1229's scan). */
export function heroStartStrings(): string[] {
  return Object.values(HERO_START).flatMap((l: L) => [l.ar, l.en]);
}

export const chipHref = (lang: Lang) => `/${lang}/updates`;
