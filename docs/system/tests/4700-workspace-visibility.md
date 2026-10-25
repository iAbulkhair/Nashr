# Coverage: workspaces visible in the app and the founder console (rules 4700-4709)

Status on 2026-10-25 on branch `claude/workspace-dashboard-visibility-4f6f0b` (cut from main abbf2882). The founder reported that workspaces did not show in the customer dashboard (owner and team) or in the console. Causes: the app switcher was drawn only with two workspaces or more; every console row linked by the owner's address alone, so an owner's second workspace opened the first; `GET /api/admin/people/{email}` (rule 2755) had no screen. Release step: none (no stored shape changes; `?ws=` is a new selector only).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4700 | The console's workspace page takes `?ws={handle}`: matched only among the accounts the chosen address's person holds now (`heldAnywhere`, `matchHandle`), a handle they do not hold answers 404, another shape is ignored; list rows carry their handle and link with it | yes | `tests/admin-workspace-pick.test.ts` (rule 4700 block) |
| 4701 | The Team tab lists each member's workspaces with their role, read from the people view only when asked, each linked by handle | yes (by source pin) | `tests/admin-workspace-pick.test.ts` (rule 4701 block) |
| 4702 | The app's workspace switcher is drawn with one workspace too, for the owner and every member, and its menu opens «All workspaces» | yes (by source pin) | `tests/admin-workspace-pick.test.ts`, `tests/multi-org-workspaces.test.ts` |
| 4703-4709 | Reserved | | |

Not changed: the console's workspace edit (`POST /api/admin/users/{email}/workspace/edit`) still resolves the address's home workspace, so for an owner of several workspaces it edits the first one; it is not on the workspace page.
