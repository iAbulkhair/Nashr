# Agent scope: the founder's switches ask a reason and speak the founder's language (rules 1500-1503)

Status on 2026-10-13 on branch `claude/agent-scope-toggles` (draft PR, from `main` 4c0264b4, after #345 reached `main` in batch #347; not live). The founder asked for a toggle per control in the console and kept shadow as the default. The four selects existed since rule 1412; this change makes them follow the console's rules for a founder change. Rules 1500-1503 are this change; 1504-1509 of the block stay free. Nothing stored changes shape: `agent-scope:modes` keeps the same four fields and values, and `admin:log` rows gain a `reason`, a field every reader already knows (rule 679 not involved).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1500 | `POST /api/admin/agent-scope/modes` takes `reason` and refuses a missing or short one with 400 `reason_short` and one over 200 characters with 400 `reason_long` (`reasonRefused`, rule 1185), after `adminActor` (401), `secondFactorRefusal` and the `bad_mode` check, before any read; nothing is written on a refusal; the `eval_not_passed` gate is unchanged | `tests/agent-scope-admin.test.ts` ("rules 1500-1501: the modes route asks a reason") | — |
| 1501 | The reason, trimmed to one line, is written into the change's `admin:log` row (section `quality`, `what: "agent_scope_modes"`) through `adminAudit` | same | — |
| 1502 | `AgentScopePanel` names every stored value in Arabic and English (on «مفعّلة» On, off «متوقفة» Off, shadow «مراقبة فقط» Watch only, enforce «ترفض فعلاً» Refuse) and shows, under each select, what the stored value does for that layer; the options' stored values stay on/off/shadow/enforce; `reason_short` and `reason_long` have words in both languages | `tests/agent-scope-admin.test.ts` ("rules 1502-1503: the panel's switches") | — |
| 1503 | Picking a value saves nothing: it opens the console's reason form (`useAdminForm`, rule 1176) showing "from → to" and what the new value does; Cancel or Escape posts nothing and puts the select back on the stored value; Apply posts the one field with the reason. No browser `prompt` or `confirm`. `AGENT_SCOPE_DEFAULT_MODES` stays prompt on, the other three shadow | same (source checks, and the defaults) | A rendered test that picks a value, cancels, and reads the select back |

## Notes

- `docs/system/permissions.md` route row 182 and section "Agent scope" item 2, and `docs/system/flows.md` section 54 item 7, name the reason and the labels.
- The log table on the panel shows the mode of each line with the same labels.

## Not pinned

- The reason form's open, cancel and apply are pinned only by the source checks above and by the `AdminForm` tests of rule 1176 (`tests/uiux-phase4.test.ts`); no test renders the panel and drives the select.
