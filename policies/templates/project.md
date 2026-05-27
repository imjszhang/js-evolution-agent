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
- Any `agent_execute` or `run_probe` action that reads or writes local files should identify the resource first, then the root. Prefer `params.resource_scope` / `params.resource_kind`; keep `params.cwd` as the compatibility execution root.
- Common scopes are `subject_runtime` for this subject's runtime data, `source_root` for the js-evolution-agent host repository, and a subject-specific external scope for owned external projects.
- Paths in the action objective should be relative to the resource root / `params.cwd`; avoid mixing multiple absolute project roots in a single action.
- Missing-path evidence is root-qualified. A probe may say "path Y is missing under executionRoot X"; it must not generalize that into "module missing" or "write frozen" unless X is the authoritative root for that resource.
- If `params.cwd` conflicts with the resource scope, the action should fail with `root_mismatch` rather than run in the wrong project.
- If the intended `cwd` does not exist, the action should fail rather than create a replacement directory.

## Subject Repo Lane

- Repo: `D:\path\to\{{subject}}`
- Base Branch: `main`
- Lane: `jea/{{subject}}/local`
- Work Branch Prefix: `jea/{{subject}}/work` (optional; default; must not nest under Lane)
- Test Command: `npm test`
- Run Command: `npm start`

## Probe Requirements

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`
