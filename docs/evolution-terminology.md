# Evolution terminology (event-driven)

Status: accepted. Date: 2026-08-24.

This ADR names the live scheduling model. Implementation already consumes evidence; this document stops using `continuous` / `on_demand` as if they were the scheduler.

## Four layers

| Layer | Canonical term | Meaning |
| --- | --- | --- |
| Scheduling | Event-driven | New evidence / wake / explicit reaction request can start work. Heartbeat never invents Cognitive work. |
| Run switch | `evolution.state` | `active` automatically consumes eligible wakes. `paused` starts no new Cognitive / Exec / Rule work; verify, settlement, and Memory may still finish. |
| Work unit | Reaction | One bounded reactor task (or a short chain). Not a Cycle train. |
| Vocabulary | Evidence / Wake / Task / Reaction / Settlement | Keep these distinct. Do not say "open a cycle" for live work. |

## Compatibility

- `evolution.automation` (`automatic` / `paused`) stays the Desktop product field. Writers keep `state` and `automation` in sync.
- `evolution.mode` (`continuous` / `on_demand`) is deprecated. It is still readable and writable, but it does not change scheduling. Both values map to `active`.
- `jea daemon cycle request` and `--domain cycle` remain aliases of `reaction request` and `--domain evolution`.
- `JEA_TICK_OPEN_CYCLE` is retired as a live switch. Heartbeat never enqueues tick-only work. Leftover tick-only requests are consumed and ignored.

## Operator commands

```text
jea daemon evolution-state show
jea daemon evolution-state set active|paused
jea daemon reaction request
jea daemon start --domain evolution
```

Desktop `service.setAutomation` and `service.requestCycle` / `service.processCycleOnce` stay on protocol 1.0.0. Typed client aliases `requestReaction` and `processEvolutionOnce` call the same commands.

## Acceptance

1. Worker alive + new eligible evidence → automatic Cognitive reaction. No cycle-open required.
2. No evidence → heartbeat never creates Cognitive work.
3. `paused` → no new Cognitive / Exec / Rule side effects; verify / settlement / Memory may finish.
4. "Check now" / reaction request produces an explicit operator wake.
5. Subjects that already used `on_demand` keep consuming evidence while `active`.
6. Live completion is claims / checkpoints / exec intents / results / settlements, not cycle-state.
