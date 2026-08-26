# 0.3.0 Reactor control-plane contracts

This is the Wave A contract surface for [#210](https://github.com/imjszhang/js-evolution-agent/issues/210). Downstream issues #211–#215 must import these modules and must not invent private schemas.

Entry: `src/contracts/reactor-control-plane.mjs`  
Contract version: `0.3.0` (package version is also `0.3.0`; the two strings are distinct: this file is the control-plane *contract*, not a second product version)

Control-plane state is **derived and rebuildable**. It is never authority for evidence, beliefs, goals, receipts, or settlements.

## 1. Activation identity

Semantic key that survives journal generation changes:

```text
reactor + evidence_key + activation_policy_version
canonical: aiv1/<reactor>/<activation_policy_version>/<evidence_key>
```

`activation_policy_version` is the eligibility/routing epoch (starts at `activation-policy.v1`). It is **not** the npm package version and **not** a journal generation.

### Valid

```js
buildActivationIdentity({
  reactor: 'cognitive',
  evidence_key: 'operator_briefs:brief-1',
  activation_policy_version: 'activation-policy.v1',
});
// key: aiv1/cognitive/activation-policy.v1/operator_briefs:brief-1
```

Recomputing the key after a process restart or after `journal_generation` 1 → 2 yields the same string.

### Invalid / silent backfill

A policy-version change (`activation-policy.v1` → `activation-policy.v2`) must **not** create historical work unless an authorized, non-preview `policy_backfill` replay epoch matches both versions:

```js
evaluateActivationPolicyChange({
  from_activation_policy_version: 'activation-policy.v1',
  to_activation_policy_version: 'activation-policy.v2',
  replay_epoch: null,
});
// { allowed: false, action: 'require_replay_epoch', code: 'replay_epoch_required' }
```

Journal generation change never creates work:

```js
evaluateJournalGenerationChange({ from_generation: 1, to_generation: 2 });
// { creates_work: false, preserves_identities: true }
```

## 2. Activation Ledger / Reactor Inbox

Required fields: `schema_version`, `reactor`, `identity`, `lane`, `state`, `activation_reason`, `priority`, `created_at`, `updated_at`, `origin`.

| Field | Values |
| --- | --- |
| `lane` | `realtime` \| `replay` |
| `state` | `ready` \| `claimed` \| `deferred` \| `blocked` \| `handled` |
| `origin` | `explicit` \| `legacy_fallback` \| `replay_epoch` \| `legacy_unknown` |

`handled` is terminal **for that identity**. A later policy epoch may create a *different* identity only through an explicit replay epoch.

### Legal transitions

| from | to | kind |
| --- | --- | --- |
| ready | claimed | `claim` |
| ready | deferred | `defer` |
| ready | blocked | `block` |
| ready | handled | `handle` |
| claimed | ready | `release`, `reclaim_lease_expired` |
| claimed | deferred | `defer` |
| claimed | blocked | `block` |
| claimed | handled | `handle` |
| deferred | ready | `undefer` |
| deferred | blocked | `block` |
| deferred | handled | `handle` |
| blocked | ready | `unblock` |
| blocked | handled | `handle` |
| handled | * | none |

Illegal examples: `deferred → claimed`, `blocked → claimed`, `handled → ready`, `claimed → ready` with kind `policy_backfill`.

### Reclaim vs replay

- **Reclaim after lease expiry**: same identity, `claimed → ready`, kind `reclaim_lease_expired`, lease actually expired. `classifyActivationReappearance` → `reclaim_lease_expired`.
- **Replay after policy change**: new identity, requires authorized replay epoch. `classifyActivationReappearance` → `policy_backfill`.
- **Journal generation change**: same identity, `creates_work: false`. Not a reclaim and not a backfill.

## 3. Scheduler / operator states

Derived, not stored as a write-ahead machine:

```text
listening | queued | running | catching_up | paused_budget | blocked | waiting_approval | stalled
```

Objective facts only. **Heartbeat / `worker_alive` never implies `running` or `catching_up`.**

`catching_up` requires:

1. an active replay claim **or** replay task, and
2. recent checkpoint progress (`last_progress_at` within `progress_fresh_window_ms`, default 60s).

Non-overlapping mechanical stop predicates:

| predicate | true when |
| --- | --- |
| `paused_budget` | `budget_exhausted` |
| `blocked` | mechanical blocker **and not** budget exhausted |
| `stalled` | in-flight, progress not recent, **and not** budget / mechanical / approval |

## 4. Progress / count invariants

Bounded projection: per-reactor, per-lane `ready + claimed + deferred + blocked` (`open_total`). `handled_total` / `handled_checkpoint` are separate.

- Evidence authority counts (`evidence_authority.envelope_count`) are **not** work counts (`is_work_count: false`).
- Cognitive / Rule / Memory counts may overlap the same authoritative evidence and **must not** be added. Combined fields such as `work_total` are rejected.
- Records must not contain `payload`, `secret`, evidence bodies, or API tokens.

## 5. Compatibility

0.2.x evidence, claim, wake, cursor, checkpoint, and settlement remain readable through `readCompatible*`. Missing 0.3.0 fields are `legacy_unknown`. Implementations must not fabricate `activation_reason` or handled identity from kind / journal offset.

`policies/release/closure-target-0.2.0.json` is frozen and is not part of this contract.
