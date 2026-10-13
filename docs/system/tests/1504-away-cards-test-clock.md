# Rule 485's away-card test reads its cards back at the turn's own time (test fix, 2026-10-13)

No rule is added or changed; 1504 only names this note (1505-1509 stay free). Rule 485's row in `docs/system/tests.md` is unchanged.

`tests/secretary-away.test.ts`, "a real turn: Reem's reply carries her contact_away cards, at most 5": the turn runs with the clock frozen at `NOW` (2026-10-06 12:00 Riyadh), and the cards are stored with their 7-day lifetime (`AWAY_PROPOSAL_TTL_S`) from that frozen time. The test then read them back with `history()` and the proposals index at the real clock, so from 2026-10-13 09:00 UTC every card read as `expired` and the test failed. It failed the CI run of release pull request #355 (started 09:13 UTC) and fails on `main` 84a55c19 locally. The read-back now runs inside `at(NOW, …)`, like the turn. The product is not affected: a real card is read back within its own seven days.

## Not pinned

- Other tests that store a value with a lifetime under a frozen clock and read it at the real clock would fail the same way when their date passes. No sweep was made; the full suite passes on 2026-10-13.
