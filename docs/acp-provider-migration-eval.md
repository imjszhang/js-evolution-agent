# ACP provider migration evaluation

- Recorded at: 2026-08-15T11:47:11Z
- Scope: Epic #50 / issue #58
- Decision: keep the existing provider default; retain `acp:claude-code` as an explicit opt-in

## Comparison contract

`scripts/acp-provider-compare.mjs` locates legacy and ACP providers by identity,
not array order. A recommendation of `acp_candidate` requires a valid ACP
receipt and finite verification-attempt counts; missing metrics keep the
legacy default. Write-profile comparisons fail closed unless each provider
receives an isolated execution root. Isolation clones comparison context while
keeping `ai`, logger, and host services, then overwrites conflicting action
fields (`params.cwd`, `run_spec.primary_cwd`, and related aliases). The harness
calls `applyRunSpecToAction` / `resolveActionExecutionRoots` and refuses to run
when the resolved root is not the requested isolation root. The report records
the resolver's actual execution root. A candidate report never changes
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
platform process-tree tests. Smoke creates a temporary JEA fixture root,
sends Channel traffic only to that fixture subject, and requires ACP
`startSession`, `prompt`, and `closeSession` to each succeed. The report
records the fixture root and ACP execution root; both temporary roots are
removed even when startup or validation fails. The real project
the source checkout and default user JEA Home must stay unchanged.

| Platform | Test | Typecheck | Build | Hidden-window smoke | Process tree |
| --- | --- | --- | --- | --- | --- |
| Linux | pass | pass | pass | pass | pass |
| Windows | pass | pass | pass | pass | pass |
| macOS | pass | pass | pass | pass | pass |

Local evidence at this revision (2026-08-15T11:47:11Z, darwin):

- `npm test`: 1235 passed / 10 skipped
- Channel / ACP compare / POSIX process-tree / smoke-fixture targeted tests: 36 passed / 2 skipped
- `npm run desktop:test`: 77 passed
- `npm run check`, `desktop:typecheck`, `desktop:build`, `desktop:smoke`: passed
- smoke stages: fixture subject `smoke-desktop` only; Channel send ok; ACP start/prompt/close ok; leftover 0; real source checkout and default user JEA Home unchanged

PR #106 CI at `2cd081e` passed on Ubuntu, macOS, and Windows, including
CodeQL and dependency audit. Post-review follow-up commits must rerun the same
required checks before merge.
