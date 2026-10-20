# Coverage: agent limits in the founder's workspace view (rules 2360-2369)

Status on 2026-10-20 on branch `claude/lucid-faraday-kq261a`. Item 3 of the OpenDots adoption order (`docs/OpenDots_Adoption.md`); flows in `docs/system/flows.md` section 94. Rules 2361-2369 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2360 | `workspaceView` gives each brand its agent tool authority as restrictions only (`{agent, cap, mode}` for `ask` and `off`), read from the brand's own stored scope; none is an empty list; the Workspace tab shows them as text, "Every agent may do everything" when empty | `tests/tool-authority.test.ts` ("rule 2360") (the view); the tab's rendering is not tested | a render test of `WorkspacePanel` with limits |
