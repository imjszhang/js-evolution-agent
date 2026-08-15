# ACP provider migration evaluation

- Recorded at: 2026-08-15T10:05:15Z
- Scope: Epic #50 / issue #58
- Decision: keep the existing provider default; retain `acp:claude-code` as an explicit opt-in

## Comparison contract

`scripts/acp-provider-compare.mjs` normalizes both providers against the same
action, objective, acceptance criteria, execution root, and permission profile.
The report records:

- receipt schema and acceptance status;
- verification attempts and same-session behavior;
- tool start/finish and permission-decision events;
- provider failure phase and error code;
- elapsed time and serialized result size.

The deterministic harness test confirms that both providers receive the same
fixture and that a valid ACP receipt can be marked as a migration candidate.
Real Claude runs remain opt-in because they require local login or Anthropic
credentials. A candidate report never changes `JEA_AGENT_PROVIDER`.

## Default-switch conditions

Changing the default requires a separate operator decision after repeated live
runs demonstrate all of the following:

1. ACP receipt acceptance is no worse than `claude_code_sdk`.
2. ACP verification attempts are no higher over the same fixtures.
3. Tool and permission traces remain complete.
4. Timeout, cancellation, and application shutdown leave no child process.
5. Windows and macOS smoke jobs remain green.

The current implementation does not meet the evidence threshold for an
automatic switch, so the legacy deployment default remains unchanged.

## Streaming and notification evaluation

Interactive ACP sessions already expose genuine assistant chunks. The Desktop
timeline merges adjacent chunks, keeps at most 400 events, and caps a merged
assistant segment at 200,000 characters.

The Channel pipeline does not expose DeepSeek token chunks as a public
transport contract. Desktop therefore shows durable classifier, task, presence,
speech-generation, outbox, and notify progress, then renders the append-only
final assistant record. This avoids inventing partial Channel messages or
changing approval and write semantics.

Operator-question and warning/critical attention notifications are generated
only in the Electron main process. They are deduplicated, can be disabled, and
their click action only navigates to the Todo page.

## Platform validation

The CI desktop gates run test, typecheck, build, and hidden-window smoke on
Linux, Windows, and macOS. Each smoke writes a platform-tagged JSON artifact.

| Platform | Test | Typecheck | Build | Hidden-window smoke |
| --- | --- | --- | --- | --- |
| Linux | pass (64 tests) | pass | pass | pass |
| Windows | CI evidence required | CI evidence required | CI evidence required | CI evidence required |
| macOS | CI evidence required | CI evidence required | CI evidence required | CI evidence required |

Windows additionally verifies local `.cmd` shim resolution and process-tree
termination. macOS exercises the same app lifecycle while retaining the
existing application activation behavior.
