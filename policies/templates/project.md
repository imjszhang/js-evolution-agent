# {{subject}} Project Guidance

Generated: 2026-05-11T12:10:27.8975990+08:00

## Subject

`{{subject}}` is the entity whose survival, boundary, failure, and evolution this loop observes.

## Core Layer

- operator trust, reviewability, and rollback
- legal, identity, and access continuity
- data integrity for this subject
- replace this list with the minimum functions that must not die

## Allowed First-Phase Actions

- Read and analyze context.
- Record observations, reviews, receipts, and probe proposals.
- Queue bounded follow-up decisions.

## Off-Limits Without Human Approval

- Creating commits, pushing branches, or opening pull requests.
- Running destructive commands, broad rewrites, or writing outside the configured project tree.
- Executing non-record `core` layer actions.

## Runtime Boundary Model

- The subject runtime root is `runtime/subjects/{{subject}}`; use it for this subject's local data, diaries, goals, receipts, and runtime configuration.
- If this subject depends on an external source project, declare its root explicitly here, for example: `D:\path\to\external-project`.
- Any `agent_execute` or `run_probe` action that reads or writes local files must set `params.cwd` to the real project root that owns those files.
- Paths in the action objective should be relative to `params.cwd`; avoid mixing multiple absolute project roots in a single action.
- If the intended `cwd` does not exist, the action should fail rather than create a replacement directory.

## Probe Requirements

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`
