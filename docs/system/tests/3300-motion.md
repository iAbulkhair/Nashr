# Coverage: the small motion set (rules 3300-3309)

Status on 2026-10-23. Expand only, CSS and class names, no stored shape changes. Own CSS set in `src/app/globals.css`, no package; shapes follow the supastarter animate set, rebuilt on `--ease-out` and `--duration-*`. Release step: none.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3300 | The classes `animate-fade-in/out`, `animate-zoom-in/out`, `animate-spin-slow`, `animate-slide-in-start/end/top/bottom`, `animate-accordion-down/up` and `accordion-panel` exist, each with its `motion-*` keyframes | `tests/motion-css.test.ts` (rules 3300-3309) | none |
| 3301 | Slides are logical: `--motion-dir` is 1 and -1 under `dir="rtl"`, so "from start" comes from the right in Arabic; no new rule names left or right or a fixed pixel translate | `tests/motion-css.test.ts` | none |
| 3302 | Under `prefers-reduced-motion: reduce` every new class is listed: zoom and slide fall back to a plain fade, the spinner and accordion stop | `tests/motion-css.test.ts` | none |
| 3303 | The set reads durations and easing from the existing tokens, no literal `ms` or `cubic-bezier` | `tests/motion-css.test.ts` | none |
| 3304 | The accordion opens by animating the grid row track 0fr to 1fr (no JS measuring, no height transition); used by the shared FAQ list (`QaList`) | `tests/motion-css.test.ts` | none |
| 3305 | Toasts slide in from the end side and the menu panel slides in from its anchor, behaviour unchanged | `tests/motion-css.test.ts` | none |
| 3306-3309 | Reserved | not pinned | none |
