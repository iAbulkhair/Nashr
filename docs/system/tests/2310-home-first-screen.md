# Coverage: home first screen, one sign-up label, no em-dash (rules 2310-2313)

Status on 2026-10-19 on branch `claude/thakeen-frontend-eval-49730a` (cut from main 53961842). These are the first fixes from the design review of the live home and pricing pages, which used three rubrics: tasteskill v2, its v2-experimental pre-flight list, and the Stitch design-system lens. At 1440x900 the cover's button ended at 972px, and at 768x1024 the cast wrapped into two rows that pushed it down to 1289px. The form stays under the team, as rule 1892 keeps it. The team takes less room instead. Rules 2314-2319 are the next fixes from the same review, in `2314-panels-corners-pricing.md`.

Measured in a browser on the local dev server after the change. Arabic: the button ends at 873px at 1440x900 and at 775px at 768x1024. English: it ends at 860px at 1440x900. A two-line thought can reach over the "AI agents" label line, but it never reaches the masthead or the form.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2310 | From 700px all nine figures stand in one row (52-84px wide), and the cover is tighter: 32px top padding, 12px gaps, no padding above the lineup, 96px above the row. The form under the team ends inside a 1440x900 and a 768x1024 screen. Phones keep three to a row. | `tests/home-first-screen.test.ts` (the CSS values) | an end-to-end check of the button's bottom edge at 1440x900 and 768x1024 |
| 2311 | The "AI agents" label above the team has no decorative dot. The label text stays. | `tests/home-first-screen.test.ts` | none |
| 2312 | One label for signing up: the hero form, the closing call, the industry pages, the nav and every self-serve plan card use `nav.cta` ("ابدأ مجاناً" / "Start free"). The agency card keeps "Contact us", which is a different action. The signup page's own title is unchanged. | `tests/home-first-screen.test.ts` | none |
| 2313 | The site dictionary in `src/lib/i18n.ts` has no em-dash in either language. The 11 dashes became commas or colons, including the trial line on home and pricing. | `tests/home-first-screen.test.ts`, `tests/pricing-copy.test.ts` (trial line) | none |
