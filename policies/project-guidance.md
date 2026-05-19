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
- For host code changes, `agent_execute` / `run_probe` must set `params.cwd` to the host project cwd and describe files relative to it.
- For subject runtime data work, `agent_execute` / `run_probe` must set `params.cwd` to that subject's runtime cwd and describe files relative to it.
- For external projects owned by a subject, the subject policy must declare the external project root; actions must set `params.cwd` to that root instead of searching from the host project.
- If an explicit `params.cwd` does not exist, the action should fail rather than create a shadow project directory.

## Probe Requirements

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`
