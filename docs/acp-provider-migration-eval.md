# ACP provider migration evaluation

- Recorded at: 2026-08-15T11:25:27Z
- Scope: Epic #50 / issue #58
- Decision: keep the existing provider default; retain `acp:claude-code` as an explicit opt-in

## Comparison contract

`scripts/acp-provider-compare.mjs` locates legacy and ACP providers by identity,
not array order. A recommendation of `acp_candidate` requires a valid ACP
receipt and finite verification-attempt counts; missing metrics keep the
legacy default. Write-profile comparisons fail closed unless each provider
receives an isolated execution root. A candidate report never changes
`JEA_AGENT_PROVIDER`.

The report records:

- receipt schema and acceptance status;
- verification attempts and same-session behavior;
- tool start/finish and permission-decision events;
- provider failure phase and error code;
- elapsed time, serialized result size, and execution root.

Real Claude runs remain opt-in because they require local login or Anthropic
credentials.

## Default-switch conditions

Changing the default requires a separate operator decision after repeated live
runs demonstrate all of the following:

1. ACP receipt acceptance is no worse than `claude_code_sdk`.
2. ACP verification attempts are no higher over the same fixtures.
3. Tool and permission traces remain complete.
4. Timeout, cancellation, and application shutdown leave no child process.
5. Linux, Windows, and macOS smoke jobs remain green, including process-tree
   cleanup and staged Desktop smoke.

The current implementation does not meet the evidence threshold for an
automatic switch, so the legacy deployment default remains unchanged.

## Streaming and notification evaluation

Interactive ACP sessions already expose genuine assistant chunks. The Desktop
timeline merges adjacent chunks, keeps at most 400 events, and caps a merged
assistant segment at 200,000 characters.

The Channel pipeline does not expose DeepSeek token chunks as a public
transport contract. Desktop therefore shows durable classifier, task, presence,
speech-generation, outbox, and notify progress, then renders the append-only
final assistant record. Visible Channel history is capped at 400 records.

Operator-question and warning/critical attention notifications are generated
only in the Electron main process. They are deduplicated, cooldown-limited,
can be disabled, and their click action only navigates to the Todo page.
Severity escalation may notify immediately.

## Platform validation

CI Desktop gates run test, typecheck, build, hidden-window smoke, and
platform process-tree tests. Smoke now records projection, Channel,
notification, and fake-ACP lifecycle stages.

| Platform | Test | Typecheck | Build | Hidden-window smoke | Process tree |
| --- | --- | --- | --- | --- | --- |
| Linux | local pass | pending CI | pending CI | pending CI | local pass |
| Windows | pending CI | pending CI | pending CI | pending CI | helper + AcpRuntime coverage |
| macOS | local pass | local pass | local pass | local pass | local pass |

Local evidence at this revision (2026-08-15T11:25:27Z, darwin):

- `npm test`: 1224 passed / 10 skipped
- `npm run test:coverage`: statements 69.61 / branches 60.18 / functions 78.25 / lines 72.15 (above floors)
- watcher atomic-replace tests: 100 consecutive passes
- Channel / ACP compare / POSIX process-tree targeted tests: 19 passed
- `npm run desktop:test`: 68 passed
- `npm run desktop:typecheck`, `desktop:build`, `desktop:smoke`: passed
- smoke stages: projection ok, channel get ok (send disabled on first subject), notifications ok, fake ACP start/prompt/close with leftover 0
- `npm run check` and `npm run audit:ci`: passed

Three-platform CI evidence will be recorded after this revision's required
checks complete. Do not treat this local macOS run as Linux/Windows proof.
