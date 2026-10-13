# Coverage: comparison by kind, no competitor named (rules 1740-1745)

Status on 2026-10-13 on branch `claude/comparison-generic-82e3b0` (cut from main 28e784d5). The founder decided on 2026-10-13 (option b) that the public site names no competitor: the five `/vs/{competitor}` pages and the agents article named vendors, quoted their prices and ranked Thakeen first by its own score (360 study A-008, C-008, I-015, I-016; leftovers L053). They are replaced by one page, `/{lang}/compare`, comparing four kinds of alternative: general AI chat tools, global marketing platforms, agencies and freelancers. Rules 1746-1749 are held for this change and not used.

Route change: `src/app/[lang]/vs/[competitor]` is removed and `src/app/[lang]/compare` is added (`docs/system/architecture.md`). `next.config.ts` gains `redirects()`. No permission or environment variable changed.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1740 | No public page names a removed competitor (Enrich Labs, Helena, ChatGPT, Jasper, Hootsuite, Buffer, Okara, Sintra; the list lives in the test). The scan covers `src/app/[lang]` outside the app and admin, `llms.txt`, the share pages, sitemap, robots, manifest, the public components, the copy modules in `src/lib` and `content/blog`, plus the rendered comparison page, sitemap and llms.txt. Two non-comparisons stay and are allowed by name in the test: the "ask an AI about this" link on the definition page and the changelog's "Noor inside ChatGPT" wishlist item | `tests/compare-generic.test.ts` (rule 1740 block) | — |
| 1741 | `/{lang}/compare` (`src/lib/pages-compare.ts`) shows the same four kinds in both languages, in order, each with a table, when to choose that way and when to choose Noor. No cell about the alternative states a number (no price, score or count); no score, weight, rank or "best" wording; the disclosure says it is our own opinion, gives no scores, ranks nothing, and gives hello@thakeen.com for corrections. Each kind is a section with its own heading and an anchor in the page's own menu | `tests/compare-generic.test.ts` (rule 1741 block), `tests/reskin-marketing.test.ts`, `tests/pricing-copy.test.ts` | — |
| 1742 | Every old `/{lang}/vs/...` address and `/{lang}/blog/nashr-vs-enrich-labs` answers 308 to `/{lang}/compare` (`next.config.ts`, before the proxy). The old route, `src/lib/pages-vs.ts`, `src/components/VsThem.tsx` and the vendor post are gone; the sitemap and llms.txt list `/compare` and no retired address; the resources page, footer and menus link `/compare` | `tests/compare-generic.test.ts` (rule 1742 block: matched against the real redirect list), `e2e/redirects.spec.ts` ("retired comparison addresses") | — |
| 1743 | A direct Salla or Zid link is called planned on the comparison page and in the agents article, in both languages; nothing says products are imported from Salla or Zid today. Reading a store from its public link is what works now. Takes over rule 1582 | `tests/compare-generic.test.ts` (rule 1743 block) | — |
| 1744 | The agents article (`content/blog/best-ai-marketing-agents-gulf-2026.md`, same address) compares kinds of option, not products, links `/compare` in both halves, and its title promises no count and no "best". Its table lists the kinds with Noor among them and the freelancer and agency references last. Replaces the alphabetical-order part of rule 1581 | `tests/compare-generic.test.ts` (rule 1744 block), `tests/content-claims.test.ts` (rule 1581 block) | — |
| 1745 | The home FAQ, the definition page (`/ai-marketing-agent`) and the law-firm sector page compare with a kind of tool ("a general AI chat tool", "competitors"), not a brand | `tests/compare-generic.test.ts` (rule 1740 block, "rule 1745" case) | — |

## Rules retired or changed

- 1580 (dated and sourced competitor prices on `/vs` pages) is retired: no page quotes another vendor's price.
- 1582 (Salla and Zid called planned) moves to 1743.
- 1581 keeps the opinion label and corrections line; its alphabetical order is replaced by rule 1744's order.
- 1583 (no model named) now checks `COMPARE_PAGE` and the agents article.

## Notes

- Release step: none (no stored shape changed). No conversion script.
- Shared files also edited by the UI leftovers session (1800-1829): `src/lib/i18n.ts` (footer links, one home FAQ question), `src/components/Footer.tsx` (the compare link), `next.config.ts` (new `redirects()`), `src/app/sitemap.ts`.
- `src/lib/i18n.ts` still lists "Salla (product import from URL)" among integrations: accurate (it reads the store's sitemap), left for the founder to review.
