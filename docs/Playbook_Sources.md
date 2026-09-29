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
