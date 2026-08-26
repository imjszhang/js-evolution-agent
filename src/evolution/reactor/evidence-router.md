# Incremental Evidence Router (`activation-policy.v1`)

Parent: [#208](https://github.com/imjszhang/js-evolution-agent/issues/208)  
Issue: [#211](https://github.com/imjszhang/js-evolution-agent/issues/211)  
Contracts: [`src/contracts/reactor-control-plane.mjs`](../../contracts/reactor-control-plane.mjs)

The router converts a **delta of newly appended** `EvidenceEnvelope`s into derived Activation Ledger entries. It decides whether work exists. It does not execute, schedule, group Cognitive prompts, rebuild the evidence journal, or settle beliefs/goals.

Control-plane state is **derived and rebuildable**. It is never authority for evidence, beliefs, goals, receipts, or settlements.

Identity: `(reactor, evidence_key, activation_policy_version)` → `aiv1/<reactor>/<policy>/<evidence_key>`. Journal generation is not part of identity and creates no work. Bump `activation-policy.v1` only when eligibility rules change, and then require `evaluateActivationPolicyChange` plus an authorized `policy_backfill` replay epoch. Do not silently backfill.

## Routing table

Prefer explicit `activation_targets` + `activation_reason`. 0.2.x writers often stamp broadcast `['cognitive', 'rule']` on receipts / verify reports / probes / exec events; that is **not** 0.3.0 intent. Those records use the documented fallback below.

| Evidence | Signal | Cognitive | Rule | Memory | Lane | Reason | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `operator_briefs` | explicit targets/reason | yes (one) | no | no | realtime | `operator_brief` | high |
| `operator_briefs` | 0.2.x, no explicit intent | yes (one) | no | no | replay | `legacy_fallback` | high |
| `operator_facts` | explicit targets/reason | yes (one) | no | no | realtime | `operator_fact` | high |
| `operator_facts` | 0.2.x, no explicit intent | yes (one) | no | no | replay | `legacy_fallback` | high |
| `verify_reports` | expected-output contradicted | yes | yes | no | realtime | `expected_output_contradiction` | high |
| `verify_reports` | matched / no comparison | no | no | no | — | rejected / `legacy_unknown` | — |
| `action_receipts` | normal / 0.2.x broadcast | no | yes | no | replay if no explicit intent | `rule_receipt` or `legacy_fallback` | normal |
| `action_receipts` | explicit decision-relevant rule | yes | yes | no | realtime | `decision_relevant_receipt` | high |
| `channel_events` | delivery / presence / notification / task lifecycle | **no** | no | no | — | rejected `channel_lifecycle` | — |
| `channel_events` | semantic operator input | yes | no | no | realtime | `semantic_operator_channel` | high |
| `reports` / `evolution_events` | producer = cognitive | **no** (hard) | no default | no default | — | rejected `cognitive_self_loop` | — |
| `belief_events` / `goal_events` | `settlement_id` present | no | no | yes | replay unless explicit reason | `committed_settlement` or `legacy_fallback` | normal |
| `operator_questions` | default | no | no | no | — | no documented activation | — |
| `probe_results` / `intel_observations` | default / 0.2.x broadcast | no | no | no | — | no documented activation | — |

Hard safety: Cognitive-produced reports and evolution events cannot activate Cognitive, even if `activation_targets` lists `cognitive`. Empty `activation_targets` is an explicit no-op.

## 0.2.x fallback

When realtime 0.3.0 intent cannot be established (missing `activation_reason` / `activation_policy_version` / precise targets, or only a legacy broadcast stamp):

- Do not fabricate a specific reason from kind alone on the ledger.
- Mark `origin` / `activation_reason` as `legacy_fallback` or `legacy_unknown`.
- Put any documented leftover work on the **replay** lane.
- Emit an auditable diagnostic (`legacy` / `unknown` / `rejected`).

A policy-version change cannot create historical work unless an authorized, non-preview `policy_backfill` replay epoch matches both versions.

## Public functions

| Function | Role |
| --- | --- |
| `evaluateEvidenceActivation` | Pure policy. No I/O. |
| `routeEvidenceDelta` | Incremental write of a caller-supplied envelope delta. |
| `routeJournalGenerationChange` | Generation change creates no work. |
| `evaluateRouterPolicyChange` | Wrapper around `evaluateActivationPolicyChange`. |
| `listActivationPolicyTable` | Machine-readable copy of the table above. |
| `readActivationLedger` / `insertActivationLedgerEntries` / `listActivationLedgerEntries` / `getActivationLedgerEntry` | Derived ledger store. |
| `extractGroupingIdentity` | Causal grouping IDs only (no payloads). |
| `classifyChannelEventClass` / `isExpectedOutputContradiction` / `isCognitiveSelfOutput` / `isDecisionRelevantReceipt` / `isCommittedSettlementEvidence` / `isLegacyBroadcastTargets` / `isLegacyCognitiveWakeStamp` | Classifiers used by the table. |

Ledger path (generation-scoped, owned by `activation-ledger-store.mjs`):

```text
data/evolution/reactor/evidence-index-generations/<generation>/activation-ledger.json
```

Journal generation is not part of identity. Do not keep a second reactor-root copy as authority.
