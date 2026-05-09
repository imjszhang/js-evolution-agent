# {{subject}} Project Guidance

Generated: 2026-05-09 15:55:29 +08:00

This file contains project-local clauses for `{{subject}}`. Universal Cyber-Taoist principles are read from `CONSTITUTION.md` and `SKILL.md`; do not copy or rewrite them here.

## Subject

The subject of this loop is `{{subject}}`: define what is treated as the entity that survives, trades, fails, and evolves.

## Core Layer

- Operator trust, reviewability, and reversibility.
- Legal, identity, and access continuity.
- Data integrity for this subject.
- Replace this list with the minimum functions that must not die.

## Allowed First-Phase Actions

- Read project-local files and referenced context documents.
- Generate observations, probe proposals, retrospectives, and local reports.
- Write action receipts, evolution events, and reviews under subject runtime data.
- Queue decisions for explicit execution through registered handlers.

## Off-Limits Without Human Approval

- Creating commits, pushing branches, or opening pull requests.
- Running destructive shell commands or large cross-project rewrites.
- Writing outside the configured project tree.
- Executing a `core` layer action beyond recording a review request.

## Probe Requirements

Every probe must state:

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`

If any field is missing, the action should fail early and write no external side effects.
