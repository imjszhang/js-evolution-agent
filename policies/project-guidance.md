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

## Probe Requirements

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`
