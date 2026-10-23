# Coverage: blog and help content, rich posts, language fallback, covers, bylines, Markdown copies (rules 3310-3318)

Status on 2026-10-23 on branch `claude/sup-site-content`, built on top of `claude/sup-site-blog` (rules 3140-3143), which is not on `main`. Eight public-site items taken from supastarter's marketing and docs apps (the ideas; the code is ours). Rules 3319-3329 are reserved and unused. Release step: expand only, no stored shape changes (files, not Redis, hold the content; every new front matter field is optional).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3310 | The tag helpers of rule 3140 are pinned at their edges: `splitTags` collapses inner whitespace and line breaks and keeps a stray comma as an empty piece; `tagKey` ignores case and spacing; `tagProblems` accepts exactly `MAX_TAGS` tags of exactly `MAX_TAG_LENGTH` characters, names every problem at once, and reads empty pieces as empty, never as a repeat; a front matter value of blanks is no tags; each language is checked on its own; `tagFromParam` takes the first value only; `filterByTag`, `allTags`, `isActiveTag` and `blogHref` agree on case, spacing, Arabic and characters that end a query. | `tests/blog-tags.test.ts` (block "edge cases of the tag helpers") | none |
