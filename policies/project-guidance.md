# js-evolution-agent Project Guidance

Generated: 2026-05-09 13:57:06 +08:00

This file contains project-local clauses for `js-evolution-agent`. Universal Cyber-Taoist principles are read from `CONSTITUTION.md` and `SKILL.md`; do not copy or rewrite them here.

## Subject

The subject of this loop is `js-evolution-agent`: a controlled host instance that reuses `js-evolution-engine`, reads Cyber-Taoist context, and persists intelligence through `js-intel-store`.

## Core Layer

- The source packages `js-evolution-engine` and `js-intel-store`.
- The read-only Cyber-Taoist documents under `cyber-taoist-docs`.
- Operator trust, reviewability, and reversibility.
- Local data integrity under `js-evolution-agent/data`.

## Allowed First-Phase Actions

- Read project-local files and referenced context documents.
- Generate observations, probe proposals, retrospectives, and local reports.
- Write action receipts, evolution events, and reviews under `js-evolution-agent/data/intelligence`.
- Queue decisions under `js-evolution-agent/data/evolution`.

## Off-Limits Without Human Approval

- Modifying `js-evolution-engine`, `js-intel-store`, or `cyber-taoist-docs`.
- Creating commits, pushing branches, or opening pull requests.
- Running destructive shell commands or large cross-project rewrites.
- Writing outside the `js-evolution-agent` project tree.
- Executing a `core` layer action beyond recording a review request.

## Probe Requirements

Every probe must state:

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`

If any field is missing, the action should fail early and write no external side effects.

