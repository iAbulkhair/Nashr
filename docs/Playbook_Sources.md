# Agent playbook sources

The seven agent playbooks in `content/skills/` (marketing, sales, finance, gtm, reporting, executive, product) were
upgraded on 2026-09-29. Some of their structure (checklists, frameworks, templates) was adapted, in our own words,
from role files in [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) at commit `68f0153`
(MIT License, Copyright (c) AgentLand Contributors). No passage longer than a short phrase was copied.

What was deliberately NOT carried over: every statistic, benchmark, effect size, success target, named-company
example and guarantee in those files. Many of them state invented or unsourced numbers as fact, which Nashr's rule
against invented numbers, customers, testimonials and results promises forbids. `tests/playbooks.test.ts` (rule 96 in
`docs/system/tests.md`) keeps effect-size statistics and source names out of the playbooks.

The Gulf-specific content (seasons, payday, WhatsApp norms, VAT and ZATCA, payment methods, dialect rules, Saudi
advertising norms) is Nashr's own; the source repository has none.

## Keeping up with the sources

`docs/upstreams.json` pins the commit of each source repository we took ideas from (agency-agents for the playbooks,
paperclip for the agent-team mechanisms) and lists the exact files behind those ideas. Every Monday at 06:00 UTC,
`.github/workflows/upstream-watch.yml` compares each pin with the author's latest commit and, when a tracked file
changed or a new file appeared in a watched folder, opens or refreshes one issue per repository ("Upstream update:
<repo>") with the files and a compare link. It can also be run by hand from the Actions tab. Nothing is copied
automatically: review the change, take only structure (never their statistics), run the golden set, then bump
`sha` and `date` in the pin file.
