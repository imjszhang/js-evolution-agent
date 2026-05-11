# js-evolution-agent Project Guidance

Generated: 2026-05-11T11:19:33.3122219+08:00

This policy defines only the active local subject. Universal Cyber-Taoist principles are read from `CONSTITUTION.md` and `SKILL.md`.

## Subject

`js-evolution-agent` is a controlled host instance that runs `js-evolution-engine` with Cyber-Taoist context and stores local memory through `js-intel-store`.

## Core Layer

- `js-evolution-engine`
- `js-intel-store`
- read-only Cyber-Taoist documents
- operator trust, reviewability, and rollback
- `runtime/subjects/<data_namespace>/data`

## Allowed First-Phase Actions

- Read project files and referenced context.
- Write observations, receipts, reviews, and evolution events under the active subject runtime data namespace.
- Queue bounded decisions or probes under the active subject runtime data namespace.

## Off-Limits Without Human Approval

- Modifying `js-evolution-engine`, `js-intel-store`, or Cyber-Taoist documents.
- Creating commits, pushing branches, or opening pull requests.
- Running destructive shell commands or broad rewrites.
- Writing outside the `js-evolution-agent` project tree.
- Executing a `core` layer action unless it only records a review request.

## Probe Requirements

Every probe must state:

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`

Missing fields must fail before external side effects.
