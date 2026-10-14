# Coverage: home page technical fixes from the site critique (rules 1866-1872)

Status on 2026-10-14 on branch `claude/frosty-haibt-2e4d5a` (cut from main 97b02997). The site critique of 2026-10-14 listed client work the home page did not need, a doubled filter on every figure in dark mode, endless animations painting off screen, scribbles that started left to right on Arabic pages, and small touch targets. No route, permission or environment variable changed.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1866 | The cover draws the eight figures on the server (`Doodle` in `Cover.tsx`) and hands them to the client `Lineup` as a `figures` prop; `Lineup.tsx` no longer imports `Doodle`, so the drawings' code stays out of the browser bundle | `tests/home-hero-cta.test.ts` ("hands the lineup its figures drawn on the server") | — |
| 1867 | In dark mode each figure has one soft outline: one `drop-shadow` filter on `.doodle` instead of two | `tests/home-technical.test.ts`; `tests/uiux-phase5b-rest.test.ts` (the dark filter still exists) | — |
| 1868 | Every moving decoration (`Float` and the three `Seam`s in `Decor.tsx`) carries `data-loop`; `LoopPause.tsx`, rendered once in the cover, sets `data-away` on each while it is off screen (120px margin) and `home.module.css` pauses the animations under it | `tests/home-technical.test.ts` | A browser test that scrolls a seam away and reads `animation-play-state` |
| 1869 | The language layout wraps the page in `ScribbleDir` with the dictionary's direction; a client `Scribble` without its own `rtl` takes it for its first drawing, on the server and in the first client render, then the parent's measured direction, so an Arabic page draws right to left from the first paint and an LTR island keeps its own | `tests/home-technical.test.ts` (static render with and without the provider; the layout's wrap) | — |
| 1870 | The scenes slider's dots are `--hit-min` targets (the drawn dot stays 10px), the freshness chip has 6px by 16px padding inside its 44px height, and the footer's theme switch has no text under 12px | `tests/home-technical.test.ts` | — |
| 1871 | Every decorative underline, tick and divider in the home sections (Stories, Rules, Day, Gallery, Steps, HomeFaq, Closing) is `ScribbleStatic` with the page's direction; shapes that measure their box (box, bubble, pill, stamp, tape, circleLoop) stay client `Scribble` | `tests/home-technical.test.ts` | — |
| 1872 | Held for this change, not used | — | — |
