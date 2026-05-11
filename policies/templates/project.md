# {{subject}} Project Guidance

Generated: 2026-05-11T11:19:33.3122219+08:00

This policy defines only the active local subject. Universal Cyber-Taoist principles are read from `CONSTITUTION.md` and `SKILL.md`.

## Subject

`{{subject}}` is the entity whose survival, boundary, failure, and evolution this loop observes.

## Core Layer

- operator trust, reviewability, and rollback
- legal, identity, and access continuity
- data integrity for this subject
- replace this list with the minimum functions that must not die

## Allowed First-Phase Actions

- Read project files and referenced context.
- Write observations, receipts, reviews, and evolution events under subject runtime data.
- Queue bounded decisions or probes.

## Off-Limits Without Human Approval

- Creating commits, pushing branches, or opening pull requests.
- Running destructive shell commands or broad rewrites.
- Writing outside the configured project tree.
- Executing a `core` layer action unless it only records a review request.

## Probe Requirements

Every probe must state:

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`

Missing fields must fail before external side effects.
