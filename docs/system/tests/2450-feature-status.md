# Coverage: what Thakeen has switched on, for customers (rules 2450-2459)

Status on 2026-10-20 on branch `claude/lucid-faraday-kq261a`. Item 2 of the OpenDots adoption order (`docs/OpenDots_Adoption.md`); flows in `docs/system/flows.md` section 93. Rules 2453-2459 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2450 | Each customer feature is on only when the founder page's integration behind it is `on` and none of its code switches is off (paused model, `MEDIA_MODELS_ON`, `PAYMOB_LIVE`, `LLM_PROVIDER`, the Composio switch); a half-set service is off | `tests/feature-status.test.ts` ("rule 2450") | — |
| 2451 | The Connections page renders "What Thakeen has switched on" in both languages, each feature with a text badge | `tests/feature-status.test.ts` ("rule 2451") (the card, and the page's source) | a render of the whole Connections page |
| 2452 | No environment variable name reaches the customer: neither the feature data nor the card | `tests/feature-status.test.ts` ("rule 2452") | — |
