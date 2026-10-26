# Coverage: Thakeen v2 phase 4, the research tool (rules 4790-4808, 4809-4819 reserved)

Status on 2026-10-26 on branch `claude/thakeen-v2-p4-research` (after phase 3, 89c7bcc0). Component C10 of the Claude Doc "Thakeen v2 — PRD, Spec and Roadmap". Flow in `flows.md` section 140; keys in `architecture.md` section 3.z.5; `permissions.md` "Research tool"; the provider key in `variables.md` section 5e. Release step: **expand** (new keys `researchprop:*`, `researchprops:*`, `researchok:*`, `researchurls:*`, usage field `search_usd_micro`, optional chat message field `research`, action prefix `research:`). Dormant: `RESEARCH` is `false` in `src/lib/v2-flags.ts`. New optional environment variable `BRAVE_SEARCH_API_KEY`. Founder decisions still open: the price per search (`SEARCH_CREDITS`, a placeholder of 1 credit), the key, a per-agent switch on the Governance page, and turning it on for customers.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4790 | `RESEARCH` ships `false`; off, no agent is offered `web_search` or `read_page`, both are unknown tools, the card route is 404 and nothing is stored or fetched | yes | `tests/v2-research.test.ts` (rule 4790 block) |
| 4791 | Only Faris, Noor and Layan are offered the tools (`RESEARCH_AGENTS`, keyed by every agent so a ninth is a type error) | yes | `tests/v2-research.test.ts` (rules 4791-4797 block) |
| 4792 | Another agent's call is "Unknown tool." with the flag on | yes | `tests/v2-research.test.ts` (rules 4791-4797 block) |
| 4793 | Never over MCP or for an API token; nothing is stored | yes | `tests/v2-research.test.ts` (rules 4791-4797 block) |
| 4794 | The person chatting needs `generate`; a viewer is refused and nothing is stored | yes | `tests/v2-research.test.ts` (rules 4791-4797 block) |
| 4795 | Both tools carry `generate` in `TOOL_ACTION`, checked by the gateway and the tool | yes | `tests/role-gates.test.ts`; `tests/v2-research.test.ts` |
| 4796 | The gateway's authority for `web_search` is "ask" for every workspace | yes (source) | `tests/v2-research.test.ts` (rules 4791-4797 block) |
| 4797 | A team note-taker is refused both tools (they are not in `NOTE_TOOLS`) | yes (source) | `tests/v2-research.test.ts` (rules 4791-4797 block) |
| 4798 | The first `web_search` stores a proposal and a card (`research:{id}`, message field `research`), runs nothing and charges nothing; a bad query proposes nothing; one search a reply | yes | `tests/v2-research.test.ts` (rules 4798-4801 block) |
| 4799 | After Approve, the agent's next call takes the approval once (GETDEL) and runs the stored query, never the model's new input; the approval is for its own agent and thread | yes | `tests/v2-research.test.ts` (rules 4798-4801 block) |
| 4800 | The run charges `SEARCH_CREDITS` under the agent's and the person's caps, meters `search_usd_micro`, and keeps the result addresses for the thread for an hour; no credits, nothing is searched | yes | `tests/v2-research.test.ts` (rules 4798-4801 block) |
| 4801 | A failed or unconfigured provider refunds the charge; the key is sent only as a header to the fixed address and is never logged | yes | `tests/v2-research.test.ts` (rules 4798-4801 block) |
| 4802 | `GET /api/chat/research/{id}` needs `read`, is rate-limited per scope, and returns the card without its author or thread | yes | `tests/role-gates.test.ts`; `tests/v2-research.test.ts` (rules 4802-4805 block) |
| 4803 | `POST /api/chat/research/{id}` needs `generate`, is rate-limited per scope, takes only `approve` or `dismiss` (400 otherwise), and 409 once answered | yes | `tests/role-gates.test.ts`; `tests/v2-research.test.ts` (rules 4802-4805 block) |
| 4804 | The id is format-checked before a key is built; another workspace's id is 404; a viewer reads the card but may not approve it | yes | `tests/v2-research.test.ts` (rules 4802-4805 block) |
| 4805 | The route is in `BRAND_API` (one brand's record) | yes | `tests/brand-url-proxy.test.ts` |
| 4806 | `read_page` opens only an address an approved search returned in the thread, or one the person wrote; http(s) only, no credentials, no fragment; three pages a reply; free | yes | `tests/v2-research.test.ts` (rules 4806-4807 block) |
| 4807 | Outside text is stripped and fenced in `<web_data>` that it cannot close or reopen, under the data rule; with `RESEARCH` on, the judge's `invented_fact` also covers claims credited to an outside source, and off the judge text is unchanged byte for byte | yes | `tests/v2-research.test.ts` (rules 4806-4807 and 4808 blocks) |
| 4808 | The wipe removes every proposal, approval token, address list and the index; the card's words exist in both languages with Western digits and render no markup; the key is named in `variables.md` | yes | `tests/v2-research.test.ts` (rule 4808 block); `tests/key-registry.test.ts` pins the keys |
| 4809-4819 | Reserved for C10 follow-ups (the Governance switch, an "on" mode, the price) | | |

Not verified today: the Brave Search API itself (no live call was made; the response shape follows its documentation) and the card in a browser. `next build` was not run locally.
