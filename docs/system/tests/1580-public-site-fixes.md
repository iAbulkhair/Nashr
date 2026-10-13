# Coverage: public-site fixes (rules 1580-1589)

Status on 2026-10-13, branch `claude/public-site-fixes` (no pull request; the coordinator batches it). The founder delegated these decisions on 2026-10-13: keep competitor names on the comparison pages, date and source every competitor price or drop it, no ranking of Thakeen first by our own score, Salla and Zid links called planned until the apps are approved, no model names, Western digits everywhere. The rest are UI leftovers from the 360 study (E-010, E-018 to E-025). Rules 1590-1599 are held for this change and not used. No route, permission or environment variable changed.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1580 | A competitor price on a `/vs` page carries its date (`PRICES_AS_OF`, 17 Sep 2026) and a link to its public source (`VsRow.src`), rendered by `VsThem`; only Enrich Labs keeps a figure (source in PRD.md and the pricing spec); the ChatGPT ($20) and Jasper ($49) figures had no source in the repository and now say "see their pricing page" with a link | `tests/public-site-fixes.test.ts` (rule 1580 block) | — |
| 1581 | The "AI marketing agents for the Gulf" article is labelled as our own opinion, with no score, weight, total or rank; tools are alphabetical and the agency reference comes last; its corrections line gives hello@thakeen.com in both languages. Replaces the rubric arithmetic part of rule 64 (the weighted totals no longer exist) | `tests/content-claims.test.ts` (rule 1581 block) | — |
| 1582 | Comparison pages and the agents article call the Salla and Zid links planned until both platforms approve the apps, in both languages | `tests/public-site-fixes.test.ts` (rule 1582 block) | — |
| 1583 | Comparison pages and the agents article name no AI model or model vendor (ChatGPT appears only as a competitor product) | `tests/public-site-fixes.test.ts` (rule 1583 block) | — |
| 1584 | Western digits in the whole UI, Arabic pages included: no Arabic-Indic digit in `src/components`, `src/app`, the `src/lib` copy files or the blog; no `nu-arab` formatter; the home steps use `formatNumber`. Parsers that turn typed Arabic-Indic digits into Western ones keep them | `tests/public-site-fixes.test.ts` (rule 1584 block), `tests/home-copy.test.ts` | — |
| 1585 | IBM Plex Sans Arabic loads weight 700, so Arabic bold is real, not synthesised | `tests/public-site-fixes.test.ts` (rule 1585 block) | A screenshot comparison of a bold Arabic heading |
| 1586 | Plex Arabic preloads the Arabic subset only and Plex Mono is not preloaded (11 font preloads down to 7 in the built home page; the Latin faces are still served from CSS) | `tests/public-site-fixes.test.ts` (rule 1586 block) | — |
| 1587 | Footer links are inline-flex boxes at least 24px tall (`min-h-6`), and the list keeps its row pitch | `tests/public-site-fixes.test.ts` (rule 1587 block) | A measured tap target in the browser |
| 1588 | Text arrows follow reading direction: `nextArrow`/`backArrow` in `src/lib/format.ts`, used on the tool back link, Inspo and Reports; no → in Arabic help, sector pages or the Arabic half of a blog post | `tests/public-site-fixes.test.ts` (rule 1588 block) | — |
| 1589 | Arabic words where English slipped in: the OAuth consent screen is Arabic by default (English when `?lang=en` or the browser asks), the help and partner email fields and the main menu label are Arabic on Arabic pages | `tests/public-site-fixes.test.ts` (rule 1589 block) | A rendered consent screen in both languages |

## Notes

- Release step: none (no stored shape changed). No conversion script.
- Prices for ChatGPT (SAR 90) and Jasper ($69 per seat, $59 yearly) exist in `docs/superpowers/specs/2026-09-29-pricing-design.md`, checked 29 Sep with sources; the site did not use them because the date the founder chose is 17 Sep. Adding them back is one `them` string and the existing `src`.
- Homepage and sector pages that say Noor reads a store from its link were left as they are: reading a public link works today; only the direct Salla and Zid link is planned.

## Not done

- Home page weight (built `ar.html` 748,879 bytes): inline Scribble SVGs are about 297 KB (251 of them, already at one decimal), the flight payload about 212 KB (repeats Scribble props and 26 KB of path data), home Doodle SVGs about 3 KB. No trim without a visual change was found that is safe without a browser comparison; the next step is to draw Scribble outlines once on the client from their seed instead of shipping each path in the HTML, checked by screenshot.
- Automated accessibility check: `axe-core` is only a transitive dev dependency (through `eslint-plugin-jsx-a11y`), not in `package.json`; the task forbids adding dependencies, and a spec relying on a transitive package breaks silently when the parent drops it.
- Old `nashr_` cookie, storage and token names were not renamed (rule 679 needs expand and contract); the plan is in the branch report.
