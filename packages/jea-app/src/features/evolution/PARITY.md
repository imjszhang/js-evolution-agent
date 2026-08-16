# Evolution Inspector parity inventory

Marks each legacy Evolution Viewer capability as `included`, `legacy-only`, or
`deferred`. Deferred items stay in the standalone Viewer; they are not implied
removed.

| Feature | Mark | Notes |
| --- | --- | --- |
| Show current/open cycle when one exists | `included` | Prefers `cycle_status=open` from `getCycle`. |
| Recent historical cycles when no open cycle | `included` | Falls back to `listCycles` order. |
| Compact timeline: cycle id, status, time | `included` | |
| Step/checkpoint progression badges | `included` | Statuses from `getCycle.steps`. |
| Report TLDR / availability | `included` | Full Markdown HTML stays in Viewer. |
| Diary items and TLDR | `included` | No raw diary HTML. |
| Verify status and semantic conclusion | `included` | `available` / `semantic_status` / counts. |
| Blocker and step-error summary | `included` | |
| Action receipt and evidence summary | `included` | Receipt count + attention count. |
| Conversation-to-cycle navigation helper | `included` | `openEvolutionCycle` / `selectedCycleId`. |
| Realtime refresh via `evolution.updated` | `included` | Subject-scoped; deduped by `cycle_id`. |
| Empty / missing / malformed safe states | `included` | |
| Light/dark readable + keyboard sections | `included` | Collapse/expand owned by #115. |
| Ops Home KPI dashboard | `legacy-only` | Standalone Viewer landing page. |
| Channel pipeline animation | `legacy-only` | Out of 0.1.0 scope. |
| Channel event feed / workers / presence | `legacy-only` | |
| Raw evolution event stream | `legacy-only` | |
| Daemon control bar in Viewer | `legacy-only` | Service slot is a separate feature. |
| Offline static Viewer build | `legacy-only` | Not a replacement. |
| Full marked report/diary HTML | `legacy-only` | Inspector shows TLDR/summary only. |
| Daemon task queue table | `legacy-only` | |
| Standalone `#cycle-` hash routing | `legacy-only` | App uses the navigation helper instead. |
| Complex timeline filter/search | `deferred` | Not implied removed. |
| Cross-Subject comparison | `deferred` | Not implied removed. |
| Every raw observability/evidence field | `deferred` | Not implied removed. |
| Editing reports/receipts/evidence/goals/beliefs | `deferred` | Read-only Inspector. |
| Full Ops Home / Viewer parity | `deferred` | Legacy Viewer remains. |
