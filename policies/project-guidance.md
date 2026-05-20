# js-evolution-agent Project Guidance

Generated: 2026-05-11T12:10:27.8975990+08:00

## Subject

`js-evolution-agent` is this project's controlled self-evolution host.

## Core Layer

- operator trust, reviewability, and rollback
- local subject data integrity
- external core packages and Cyber-Taoist documents are out of scope for this phase

## Allowed First-Phase Actions

- Read and analyze context.
- Record observations, reviews, receipts, and probe proposals.
- Queue bounded follow-up decisions.

## Off-Limits Without Human Approval

- Modifying core packages or external documents.
- Creating commits, pushing branches, or opening pull requests.
- Running destructive commands, broad rewrites, or writing outside the project tree.
- Executing non-record `core` layer actions.

## Runtime Boundary Model

- Host project cwd: `D:\github\My\js-evolution-agent`.
- Subject runtime cwd pattern: `D:\github\My\js-evolution-agent\runtime\subjects\<subject-name>`.
- Local file actions should identify the resource before the directory. Prefer `params.resource_scope` / `params.resource_kind`; keep `params.cwd` as the compatibility execution root.
- For host code changes, use `resource_scope=source_root` and describe files relative to the host project cwd.
- For subject runtime data work, use `resource_scope=subject_runtime` and describe files relative to that subject's runtime cwd.
- For external projects owned by a subject, the subject policy must declare the external project root and resource scope; actions must use that scope/root instead of searching from the host project.
- Missing-path evidence is root-qualified. A probe may say "path Y is missing under executionRoot X"; it must not generalize that into "module missing" or "write frozen" unless X is the authoritative root for that resource.
- If `params.cwd` conflicts with the resource scope, the action should fail with `root_mismatch` rather than run in the wrong project.
- If an explicit `params.cwd` does not exist, the action should fail rather than create a shadow project directory.

## Probe Requirements

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`
