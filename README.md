<p align="center">
  <img src="docs/img/cyber-taoist-logo.svg" alt="Cyber-Taoist logo" width="96" />
</p>

<h1 align="center">JS-EVOLUTION-AGENT</h1>

<p align="center">
  <strong>A governed self-evolution host (JEA)</strong><br/>
  <strong>Cyber-Taoist evolution theory</strong> × <strong>Loop Engineering</strong> — OADA closed loops with goal self-correction
</p>

<p align="center">
  <a href="https://cyber-taoist.ai"><strong>Theory</strong></a> ·
  <a href="https://github.com/imjszhang/cyber-taoist"><strong>Cyber-Taoist</strong></a> ·
  <a href="https://x.com/imjszhang"><strong>@imjszhang</strong></a> ·
  <a href="./README.zh-CN.md"><strong>中文</strong></a> ·
  <a href="./AGENTS.md"><strong>CLI Reference</strong></a>
</p>

<p align="center">
  <a href="https://github.com/imjszhang/js-evolution-agent/actions/workflows/ci.yml"><img src="https://github.com/imjszhang/js-evolution-agent/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/imjszhang/js-evolution-agent/actions/workflows/codeql.yml"><img src="https://github.com/imjszhang/js-evolution-agent/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/Theory-cyber--taoist.ai-FCD228?style=flat-square&labelColor=000000" alt="cyber-taoist.ai" />
  <img src="https://img.shields.io/badge/CLI-jea-000000?style=flat-square&labelColor=FCD228" alt="jea CLI" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 22.13" />
</p>

> Not a fixed `/goal` coding loop that runs until tests pass — an **evolution loop** with theoretical constraints, governance boundaries, and auditable receipts. When an old goal (law) is falsified by consequences, the system enters a rule-update phase instead of spinning or grinding.

## Product (0.2.0)

JEA 0.2.0 is a **macOS Apple Silicon** app with a bundled `jea` CLI. Its shared Electron/Web workspace has three operator surfaces:

1. **Subject and local sessions**
2. **Governed conversation** through the Channel classifier / presence / speech pipeline (chat text is not hard approval)
3. **Evolution Inspector** for the causal execution chain, expectation comparison, settlement, Memory Reactor freshness, and runtime health

Settings covers JEA Home, default Subject, CLI install, appearance, and About. Electron and localhost Web load the same React app. Install and Gatekeeper notes: [docs/release/installation.md](docs/release/installation.md). Headless lifecycle: `jea start --no-open`, `jea status --json`, `jea url`, `jea stop`.

The source-host commands below are also the development and recovery path.

---

## Table of contents

- [Product (0.2.0)](#product-020)
- [Core innovation: goal self-correction](#core-innovation-goal-self-correction)
- [Alignment with Loop Engineering](#alignment-with-loop-engineering)
- [What this is](#what-this-is)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Evolution loop](#evolution-loop)
- [Subjects and multi-subject](#subjects-and-multi-subject)
- [Daemon (long-running)](#daemon-long-running)
- [Channel](#channel)
- [Evolution Viewer](#evolution-viewer)
- [Operator input](#operator-input)
- [Configuration](#configuration)
- [Safety boundaries](#safety-boundaries)
- [Development and testing](#development-and-testing)
- [Security](#security)
- [Documentation index](#documentation-index)
- [License](#license)

---

## Core innovation: goal self-correction

Mainstream [Loop Engineering](https://x.com/addyosmani/status/2064127981161959567) assumes **the goal is fixed when the loop starts** — e.g. “all auth tests pass and lint is clean” — and the loop keeps prompting the agent until a gate passes. That works when the task boundary is clear; it breaks down in long-horizon evolution: **when the environment (Nature / 天道) has shifted and the old goal no longer produces useful feedback, the agent spins inside a wrong law**.

JEA’s core innovation is to **materialize the [cyber-taoist.ai](https://cyber-taoist.ai) framework as a mechanically executable goal self-correction mechanism**:

| Cyber-Taoist concept | JEA mapping | Role |
| --- | --- | --- |
| **Nature (N)** — ultimate environment; not directly observable, only sensed through consequences | verify reports, probe results, action receipts, external probes | Infer environmental change from verified outcomes |
| **Law (R)** — rules firewall built by the subject; always lagging | `active_goals.json`, SUBJECT.md constraints, beliefs | Current hypotheses about what to optimize and how to act |
| **Transaction (T)** — probe for sensing Nature | `agent_run`, probes, record-type actions | Interactions within law, or breakthroughs after approval |
| **Niche (NI)** — compatibility with current law | `good_signal` / `bad_signal` matching, outcome metrics | Whether strategy still works inside current law |
| **Rule-update phase** — old law falsified; new law sedimented | idempotent belief/goal settlement | **Rewrite the goal tree** from an exact verified execution window |

### Evolution stage → goal calibration

Following the constitution’s path — perception lag → probe → success/failure screening → **rule update** — rule settlement emits `rule_status`:

| `rule_status` | Cyber-Taoist meaning | System behavior |
| --- | --- | --- |
| `continue` | Regular phase: transaction feedback inside law is still clear | Keep current goals |
| `learn` | Perception lag: insufficient feedback or evidence gaps | Next round biased toward read-only learning, diagnostics, feedback-loop calibration |
| `mutate` | Rule-update phase: old law falsified by consequences | settlement **auto-applies `goal_patches`**, rewrites outcome sub-goals |
| `stop` | Core guard failure | Pause outcome exploration; restore continuity first |
| `insufficient_evidence` | Cannot infer from consequences | Do not change goals lightly; wait for more transaction feedback |

Unlike workflows that “suggest but never apply,” **`goals_calibrate` writes high-confidence calibration to `active_goals.json` by default**, logs `goal-events.jsonl` for audit, and patches like `remove_child` can retire linked beliefs.

### Why theory, not prompts alone

Without top-level constraints, goal self-correction degrades into “lower the bar on failure” or “expand scope arbitrarily.” JEA injects [CONSTITUTION.md](./policies/authority/CONSTITUTION.md) and [GUIDE.md](./policies/authority/GUIDE.md) as **authority documents** into the assess phase — the assessor must stay compatible with the constitution before citing verify / receipt / belief intelligence. Examples: after process goals (compliance, audit) are satisfied, **restore outcome pressure**; `mutate` must not bypass publish-approval boundaries in SUBJECT.md.

In short: **the loop changes not only code but, under theory, where evolution should go** — the fundamental difference from Ralph loops and fixed-goal `/goal` loops.

---

## Alignment with Loop Engineering

JEA is best read as a **governed orchestration loop** — humans design loop structure and guardrails; the system finds work, delegates to agents, verifies independently, persists state, and decides the next round (including whether goals mutate).

```text
Loop Engineering five steps     JEA 0.2.0 mapping
─────────────────────────────────────────────────────────
find work                     →  claim evidence → report → belief-bound decision
delegate to agent             →  durable exec intent → agent_run / action receipt
gate (pass/fail)              →  expected-output comparison; maker ≠ verifier
record state                  →  causal IDs, append-only events, checkpoints, receipts
decide next                   →  idempotent belief/goal settlement → Memory Reactor

JEA-specific layer            →  goal/law self-correction + SUBJECT approval + operator brief/fact
```

| Loop Engineering element | JEA implementation |
| --- | --- |
| **Scheduling** | evidence/operator wakes and bounded async reactors under `jea daemon start` |
| **Worktrees** | Subject `lane` — isolated worktrees for external target repos |
| **Persistent memory** | append-only belief/goal events plus low-frequency Memory Reactor consolidation |
| **Maker–Verifier split** | Exec writes/runs; Verify independently compares structured observations with `run_spec.expected_output` |
| **Verifiable stopping** | Per-execution verify, exact settlement refs, and closure audit |
| **Guardrails** | SUBJECT.md Off-Limits, `approval_granted`, brief/fact layering |
| **Dynamic goals** (JEA extension) | Fixed `/goal` → **mutable goals + Cyber-Taoist `rule_status`** |

```text
                    ┌──────────────────────────────────────┐
                    │  Human: Subject policy · brief · approval │
                    └─────────────────┬────────────────────┘
                                      │ guardrails
┌─────────────── Evolution Loop ──────▼──────────────────────────────┐
│ Evidence → Report → Decision → Exec → Verify → Settlement → Memory │
│    ↑                                      │                         │
│    └────────── wakes from durable evidence ─┘                         │
└────────────────────────────────────────────────────────────────────┘
         Daemon / Channel scheduling · multi-subject · Evolution Viewer
```

If you know Claude Code’s `/loop` + `/goal`: JEA adds an evolution layer on top of orchestration loops — **goals are law hypotheses that consequences can falsify and update**.

---

## What this is

`js-evolution-agent` is a **locally run evolution host** that composes:

| Component | Role |
| --- | --- |
| **OADA engine** (`src/engine/`, vendored) | Decision queue, execution handlers, verification helpers, rules / goals / guidance |
| **Cyber-Taoist authority docs** (`policies/authority/`) | Cross-subject governance context (constitution, guide) |
| **Subject policy** (`<JEA_HOME>/subjects/<ns>/SUBJECT.md`) | Per-subject semantic boundaries and approval rules |
| **js-intel-store** | File-backed intelligence memory (observations, receipts, reports, beliefs, …) |
| **CLI `jea`** | Operator entry: synchronous reactor chains, daemon, channel, data, audit |

Typical use: let an AI subject investigate, edit code, simulate, and prepare releases in a **lane worktree** or external resources, while every durable record carries enough causal identity to reopen evidence → decision → execution → verification → settlement.

---

## Features

- **Belief-driven asynchronous loop** — evidence batches wake cognitive, exec, verify, rule, and memory reactors without relying on a monolithic cycle driver
- **Causal identity** — `producer_batch_id`, `reaction_id`, `decision_id`, `execution_id`, and `belief_id` correlate the complete chain
- **Expected verification** — `run_spec.expected_output` is compared with structured result/verifier observations; execution success does not imply expectation match
- **Idempotent settlement** — sync and async paths share one evidence-window coordinator and exact receipt/verify refs
- **Memory Reactor** — low-frequency consolidation consumes settled belief/goal events instead of treating narrative as authority
- **Cyber-Taoist goal self-correction** — verified consequences can mutate goal hypotheses ([Core innovation](#core-innovation-goal-self-correction))
- **Subject isolation** — parallel subjects with separate namespaces, policies, lanes, and runtime data
- **Runtime maintenance** — bounded hot sidecars are archived/compacted conservatively; active leases, uncertain intents, and primary evidence are retained
- **Human approval and soft intent** — Brief (next-cycle intent) + `approval_granted` (hard gate)
- **Beliefs and goals** — formal update paths for testable hypotheses and goal trees
- **Multiple agent backends** — DeepSeek, Claude Agent SDK, Cursor SDK, Reasonix CLI, …
- **Channel delivery** — classifier → presence → speech → redacted outbox → notify, with handled cursors advanced only after durable speech generation
- **Operator projection** — Conversation readiness, evolution, attention, pending evidence, pending tasks, and allowed remediation remain separate canonical fields

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                         jea CLI / Daemon                         │
├──────────────┬──────────────────────┬───────────────────────────┤
│ Reactor Domain│    Channel Domain     │   Shared operator app     │
│ evidence→rule │  classifier→presence  │   projection / Inspector  │
│ →memory       │  →speech→outbox       │                           │
├──────────────┴──────────────────────┴───────────────────────────┤
│  src/engine/ (OADA)  │  src/actions/  │  src/intelligence/       │
│  queue · exec ·       │  agent_run ·   │  store · reports ·       │
│  verifyActions       │  lane · gates  │  beliefs · goals           │
├──────────────────────┴────────────────┴───────────────────────────┤
│  policies/authority/  +  <JEA_HOME>/subjects/<ns>/SUBJECT.md      │
│  <JEA_HOME>/subjects/<ns>/data/ (evolution · intelligence · goals)│
└─────────────────────────────────────────────────────────────────┘
```

Live 0.2.0 chain:

```text
EvidenceEnvelope → claimed batch → report → belief-bound decision
→ exec intent (before side effects) → exec result / action receipt
→ expected-output verify → idempotent belief/goal settlement
→ Memory Reactor consolidation → operator projection / Channel delivery
```

Legacy 0.1.0 records remain readable. Missing optional causal or comparison fields are reported as legacy/unknown; they are never fabricated. Removed driver flags and task types fail explicitly rather than selecting another live path.

---

## Requirements

- **Node.js** ≥ 22.13
- Optional: **DeepSeek API key** (use `--mock` without a key)
- Optional: Claude Agent SDK / Cursor SDK / Reasonix CLI (for `agent_run`)
- Optional: Feishu open-platform app (Channel adapter)

---

## Quick start

```bash
git clone <repo-url> js-evolution-agent
cd js-evolution-agent
npm install

# Health check
npm run doctor

# Create a subject and initialize runtime data
npm run jea -- subject init my-bot --use
npm run jea -- data init --all --subject my-bot

# Local smoke test (no real model)
npm run jea -- run --mock --subject my-bot

# Runtime overview
npm run jea -- data status
npm run jea -- intel report
```

After install, bin links work directly:

```bash
jea doctor
jea run --mock
```

For real models: copy `.env.example` to `.env`, set `DEEPSEEK_API_KEY`, then:

```bash
jea llm ping
jea run --deepseek --subject my-bot
```

---

## Evolution loop

**Synchronous entry** — useful for local validation and troubleshooting; it uses the same reactors and settlement coordinator as daemon execution:

```bash
jea run [--mock | --deepseek] [--subject NAME]
```

**Batch evolution**:

```bash
jea evolve --rounds 5
jea evolve status
jea evolve resume <run-id>
```

**Common inspection commands**:

```bash
jea intel summary [--days 7]
jea intel report [--cycle <id>] [--open]
jea daemon inbox [--json]
jea audit queue   # evolution evidence / decision queue; not npm audit
jea audit closure [--subject NAME] [--json]
jea beliefs show
jea goals show
```

Full CLI reference: [AGENTS.md](./AGENTS.md) (Chinese operator manual).

---

## Subjects and multi-subject

Each **Subject** is an independent evolution unit: its own policy, data namespace, optional lane (target-repo worktree), and channel config.

```text
~/.jea/subjects/
├── registry.json              # device-local registry (do not commit)
└── <data_namespace>/
    ├── SUBJECT.md             # governance (boundaries, approval rules)
    ├── SOUL.md                # channel persona (not Decide authority)
    └── data/
        ├── evolution/
        ├── intelligence/
        └── goals/
```

`JEA_HOME` defaults to `~/.jea` (or `%USERPROFILE%\.jea` on Windows) and can be overridden explicitly. Source files remain in the checkout, while lane repositories/worktrees remain execution roots. Existing checkout-local data is migrated explicitly:

```bash
jea daemon stop --all
jea data migrate-home --dry-run
jea data migrate-home --yes
jea doctor
```

Migration verifies every file, activates the new tree atomically, and preserves the legacy `runtime/subjects/` directory for manual rollback. 0.1.0 records remain readable: optional causal IDs, expected-output comparisons, and settlement markers may be absent and are surfaced as unknown. Rebuildable sidecars such as settlement coordination state may be reconstructed from append-only authority events; do not invent links while migrating. See [JEA Home migration](./docs/jea-home-migration.md).

```bash
jea subject list
jea subject init my-product --use
jea subject show --subject my-product
jea subject check
jea data init --all --subject my-product
```

Machine-readable registry fields (lane, resources, channels, `evolution.mode`): [`policies/subjects.example.json`](./policies/subjects.example.json). Setup details: [`policies/README.md`](./policies/README.md).

For parallel subjects, **one daemon process per subject**:

```bash
jea daemon start --subject subject-a
jea daemon start --subject subject-b
jea daemon status --all
```

---

## Daemon (long-running)

The daemon runs bounded **event-driven reactors** — recommended for unattended long runs.

```bash
# Foreground worker (cycle + channel in one process)
jea daemon start --subject my-bot

# Production: split cycle and channel for fault isolation
jea daemon start --subject my-bot --domain cycle
jea daemon start --subject my-bot --domain channel

# Windows detached background
npm run daemon:start:detached
```

| Mode | Behavior |
| --- | --- |
| `continuous` (default) | Heartbeat consumes requests and eligible wake backlog; quiet is healthy and does not create work |
| `on_demand` | Only explicit requests (`jea daemon cycle request`, operator brief, …) wake cognition |

```bash
jea daemon evolution-mode show
jea daemon evolution-mode set on_demand
jea daemon cycle request --reason "manual kick"
jea daemon status --json
jea daemon doctor
```

---

## Channel

Channel is **peer-level with cycle** — external message I/O and expression decisions. Feishu adapter is built in.

**New subject + Feishu**:

```bash
jea channel feishu setup --subject my-bot --write-env --init-subject-config
jea daemon start --subject my-bot --domain channel
# Feishu DM to bot: JEA BIND <token>
```

Inbound messages are batch-classified (**classifier**): approval intent, verification requests, operator facts, control commands, observations, … **Presence** plans expression, speech generation persists redacted content, and notify delivers the outbox. Failed/limited generation does not advance the handled cursor, so eligible input is retried without silent loss.

Channel cannot bypass approval for publish or credentials; remote publish still follows brief → Decide → `approval_granted`.

---

## Evolution Viewer

Local Web UI; by default tracks all registered subjects:

```bash
npm run viewer:serve
# or
jea intel viewer serve [--port 8787] [--open]
```

- **Developer compatibility view** — canonical evidence/task/attention counts and event stream
- **Reading view** — historical reports/diaries plus current verify and Memory artifacts
- Live API + SSE — no dist build required

Offline snapshot:

```bash
npm run viewer:build
```

---

## Operator input

Four kinds of human input — **do not mix them**:

| Type | Meaning | Typical entry |
| --- | --- | --- |
| **Constraint** | Long-term boundaries | `human_guidance.md`, SUBJECT.md |
| **Intent** | What to focus on next reaction (not fact) | `jea intel brief put` |
| **Fact** | Operator-confirmed, promotable to Seen | `operator_fact` via `jea intel ingest` |
| **Evidence** | External observations that can be overturned | `jea intel ingest` / inbox, probes |

**Actions (hard gates)** like `approval_granted` are produced by Decide and enforced during execution; operators should not edit `pending_decisions.json` directly.

Approval policy: `JEA_APPROVAL_MODE` = `manual` (default) | `auto_guarded` | `auto_all`. See [AGENTS.md § Human approval](./AGENTS.md#人工审批与操作者意图).

---

## Configuration

Copy the env template:

```bash
cp .env.example .env   # Windows: copy .env.example .env
```

| Variable | Description |
| --- | --- |
| `DEEPSEEK_API_KEY` | Real model calls (Mock if unset) |
| `DEEPSEEK_MODEL` | Default `deepseek-v4-flash` |
| `JEA_HOME` | Device-level Subject state root (default `~/.jea`) |
| `JEA_PROJECT_ROOT` | Source checkout root; does not select Subject data |
| `JEA_LANGUAGE` | UI/report language: `zh-CN` \| `en-US` |
| `JEA_APPROVAL_MODE` | `manual` \| `auto_guarded` \| `auto_all` |
| `JEA_EVOLUTION_MODE` | Default daemon evolution mode |
| `JEA_AGENT_PROVIDER` | Default agent backend |
| `JEA_EXEC_AGENT_BUDGET` | Max `agent_run` decisions consumed per exec batch (default 8); mechanical actions uncapped |
| `JEA_AGENT_MAX_CONCURRENCY` | Max parallel `agent_run` width per wave (default 2) |
| `JEA_AGENT_MAX_ATTEMPTS` | Failures before `blocked` (default 2) |
| `JEA_EXEC_LIMIT` | Deprecated alias for `JEA_EXEC_AGENT_BUDGET` |
| `JEA_QUEUE_DISABLE_CYCLE_TTL` | Explicit compatibility switch to disable cycle-count TTL; wall-clock fallback remains |
| `JEA_LLM_PROCESS_TOKEN_BUDGET` | Hard per-subject/process real-LLM token budget (default 1,000,000) |
| `JEA_LLM_REQUEST_MAX_TOKENS` | Per-request completion cap (default/max 8,192) |
| `JEA_RUNTIME_MAINTENANCE` | Enable daemon heartbeat sidecar maintenance (default on) |
| `JEA_RUNTIME_MAINTENANCE_INTERVAL_MS` | Maintenance interval (default 24h) |
| `JEA_SIDECAR_RETENTION_DAYS` / `JEA_SIDECAR_HOT_MAX` | Default archive age / hot-record bound (30 days / 1,000) |

Feishu per-subject credentials live in `<JEA_HOME>/subjects/<ns>/.env` as `JEA_CHANNEL_FEISHU_APP_ID` / `_APP_SECRET` — see `.env.example` and `policies/subjects.example.json`.

Override authority docs directory:

```bash
CYBER_TAOIST_DOCS_DIR=/path/to/custom-authority jea run
```

---

## Safety boundaries

- Investigation is read-only; only governed decisions can schedule effects.
- Exec intent is durable before a side effect. An intent left uncertain after a crash is blocked for operator reconciliation, never blindly replayed.
- Verification compares structured observations with declared expectations; agent narrative alone is not observation.
- Settlement is idempotent and append-only belief/goal events remain authoritative over rebuildable sidecars.
- **Core-layer changes** (`core_apply`) require human review by default; `JEA_CORE_APPLY_POLICY=review|disabled` tightens further.
- **Remote publish, credentials, out-of-bounds writes** are constrained by SUBJECT.md Off-Limits and `approval_granted`; Channel cannot auto-approve.
- `jea data reset --yes` deletes current subject runtime data — **destructive**; confirm subject before automation runs it.

---

## Development and testing

```bash
npm test
npm run test:ci          # default reporter + JUnit under test-artifacts/
npm run test:coverage    # V8 coverage; floors are a no-regression baseline
npm run check
npm run desktop:typecheck
npm run desktop:build
npm run audit:ci         # production npm advisories + dated exception baseline
npm run reactor:canary   # isolated mock canary; no live DeepSeek
npm run jea -- help
```

Pull requests, pushes to `main`, and merge-group checks run:

| Check | What it runs |
| --- | --- |
| `check` | Isolated `ci-repo` policy / subject / actions checks |
| `test (22)` | `npm run test:coverage` on Node 22 |
| `desktop-build` | Desktop typecheck + packable build (not a second desktop test run) |
| `dependency-audit` | `npm run audit:ci` |
| CodeQL JS/TS | Advanced setup, `build-mode: none` |

`main` is protected by a ruleset: changes go through a pull request based on latest `main`. Required checks are the jobs above. Nightly `reactor:canary` is mock-only, not a PR required check, and never injects `DEEPSEEK_API_KEY`. Live DeepSeek tests stay opt-in via `JEA_LIVE_DEEPSEEK=1`. `jea doctor` is a local diagnostic, not a CI gate.

`jea audit queue` inspects evolution evidence / the decision queue. `jea audit closure` reports belief-binding and expected-output declaration coverage, causal correlation, batch-scoped refs, duplicate-settlement candidates, Memory freshness, and separate evidence/task backlogs. Neither is the npm supply-chain audit (`npm run audit:ci`).

- Engine vendoring: [`src/engine/VENDORED.md`](./src/engine/VENDORED.md)
- Full operator / automation guide: [AGENTS.md](./AGENTS.md)
- Design notes: `journal/`

---

## Security

Vulnerability reporting and support scope: [SECURITY.md](./SECURITY.md). Remaining unfixed production advisories are tracked by [`.github/security/audit-baseline.json`](./.github/security/audit-baseline.json) and its GitHub issue, not by a static list in the policy doc.

---

## Documentation index

| Document | Contents |
| --- | --- |
| [cyber-taoist.ai](https://cyber-taoist.ai) | Evolution framework site: N/R/T/EC/NI and full constitution |
| [README.zh-CN.md](./README.zh-CN.md) | Chinese README |
| [docs/mechanism-diagram.md](./docs/mechanism-diagram.md) | Module & dual-domain mechanism diagrams (Mermaid) |
| [AGENTS.md](./AGENTS.md) | Full CLI reference, daemon/channel workflows, operator input |
| [SECURITY.md](./SECURITY.md) | Vulnerability reporting for the CLI host and Electron desktop |
| [policies/README.md](./policies/README.md) | Subject / registry / lane / goals setup |
| [policies/subjects.example.json](./policies/subjects.example.json) | Registry example |
| [policies/authority/](./policies/authority/) | Local authority doc copies (CONSTITUTION, GUIDE) |
| [.env.example](./.env.example) | Environment template |

---

## License

[MIT License](./LICENSE) — Copyright (c) [imjszhang](https://x.com/imjszhang).
