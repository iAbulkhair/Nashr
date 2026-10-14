# Coverage: the home scenes become scenarios, and the small copy fixes (rules 1840-1843)

Status on 2026-10-14 on branch `claude/frosty-haibt-2e4d5a` (cut from main 97b02997). The site critique of 2026-10-14 found that the cards under the cover read as customer testimonials (a heading that said customers tried Thakeen, a «يعجبني» / "I like" tag, quotation markup) while every card was invented, so it reframes them as scenarios. This replaces the founder's heading decision of 2026-10-11 (rule 926 keeps its "illustrative examples" line). No route, permission or environment variable changed.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1840 | The scenes heading is «كيف يشتغل أصحاب المحلات مع ذكين.» / "How shop owners work with Thakeen."; the line under it opens «أمثلة توضيحية، مو تجارب عملاء» / "Illustrative examples, not customer stories". Every card's line starts «لو عندك…» / "If you run…", names one kind of business, never a person, and no business repeats | `tests/home-scenes.test.ts` (heading, line, «لو عندك» / "If you run", unique roles); `tests/release-honesty.test.ts` (rule 926 block, now the new heading); `tests/uiux-phase5b.test.ts` | — |
| 1841 | Eight cards, four to a slide (`SCENES` in `src/lib/home.ts`, `PER_SLIDE` in `Stories.tsx`); every card wears a visible «مثال» / "Example" stamp (`SCENES_COPY.stamp`) where the like/learned/recommend tag was. Each card still names an agent and a task that agent really does, with no digit | `tests/home-scenes.test.ts` (count, stamp, the existing task and digit checks) | A screenshot of a card at 360px in both languages |
| 1842 | The cards quote nobody: a paragraph in a speech bubble and a caption paragraph, no `<blockquote>`, `<figure>` or `<figcaption>`; the heading underline and the stamp are drawn on the server (`ScribbleStatic` with the page's direction) | `tests/home-scenes.test.ts` (no quotation markup, no `kinds[` lookup) | — |
| 1843 | Copy fixes from the critique: «ثلاثة عملاء» (masculine count) in the cover banter, the FAQ heading ends with a full stop in both languages, and Instagram is spelled «إنستقرام» everywhere in `src/` | `tests/site-critique-copy.test.ts` | — |

The R1 release checklist (`docs/release/2026-10-R1-checklist.md`) is a record of a past release and keeps the wording that shipped then; its test now pins those strings literally.
