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

---

## Table of contents

- [Core innovation: goal self-correction](#core-innovation-goal-self-correction)
- [Alignment with Loop Engineering](#alignment-with-loop-engineering)
- [What this is](#what-this-is)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Evolution cycle](#evolution-cycle)
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
| **Rule-update phase** — old law falsified; new law sedimented | Phase 4 `goals assess` + Phase 4.5 `goals_calibrate` | **Rewrite the goal tree** and enter the next evolution round |

### Evolution stage → goal calibration

Following the constitution’s path — perception lag → probe → success/failure screening → **rule update** — Phase 4 emits `rule_status`:

| `rule_status` | Cyber-Taoist meaning | System behavior |
| --- | --- | --- |
| `continue` | Regular phase: transaction feedback inside law is still clear | Keep current goals |
| `learn` | Perception lag: insufficient feedback or evidence gaps | Next round biased toward read-only learning, diagnostics, feedback-loop calibration |
| `mutate` | Rule-update phase: old law falsified by consequences | Phase 4.5 **auto-applies `goal_patches`**, rewrites outcome sub-goals |
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
Loop Engineering five steps     JEA mapping
─────────────────────────────────────────────────────────
find work                     →  Phase 1 observe + analyze/decide (pending_decisions)
delegate to agent             →  Phase 2 exec (agent_run / probe / record actions)
gate (pass/fail)              →  Phase 3 verify (mechanical + semantic; maker ≠ verifier)
record state                  →  intel store, cycle-state, receipts, evolution diary
decide next                   →  Phase 3.5 beliefs + Phase 4/4.5 goals + next intel round

JEA-specific layer            →  goal/law self-correction + SUBJECT approval + operator brief/fact
```

| Loop Engineering element | JEA implementation |
| --- | --- |
| **Scheduling** | `jea daemon start` (`continuous` / `on_demand`), channel classifier tick |
| **Worktrees** | Subject `lane` — isolated worktrees for external target repos |
| **Persistent memory** | `js-intel-store`, standing memory, goal/belief events |
| **Maker–Verifier split** | Exec agent writes/runs; Verify and Goals assess are **separate phases**, not self-graded |
| **Verifiable stopping** | Per-action verify; per-cycle diary + `requires_human_review` |
| **Guardrails** | SUBJECT.md Off-Limits, `approval_granted`, brief/fact layering |
| **Dynamic goals** (JEA extension) | Fixed `/goal` → **mutable goals + Cyber-Taoist `rule_status`** |

```text
                    ┌──────────────────────────────────────┐
                    │  Human: Subject policy · brief · approval │
                    └─────────────────┬────────────────────┘
                                      │ guardrails
┌─────────────── Evolution Loop ──────▼──────────────────────────────┐
│  Intel → Exec → Verify → Belief → Goals Assess → Goals Calibrate   │
│     ↑                                      │                       │
│     └──────── next round (goals may mutate) ─┘                       │
└────────────────────────────────────────────────────────────────────┘
         Daemon / Channel scheduling · multi-subject · Evolution Viewer
```

If you know Claude Code’s `/loop` + `/goal`: JEA adds an evolution layer on top of orchestration loops — **goals are law hypotheses that consequences can falsify and update**.

---

## What this is

`js-evolution-agent` is a **locally run evolution host** that composes:

| Component | Role |
| --- | --- |
| **OADA engine** (`src/engine/`, vendored) | Decision queue, ExecutionPipeline, and Phase 1 helpers (rules / goals / guidance / logger) |
| **Cyber-Taoist authority docs** (`policies/authority/`) | Cross-subject governance context (constitution, guide) |
| **Subject policy** (`runtime/subjects/<ns>/SUBJECT.md`) | Per-subject semantic boundaries and approval rules |
| **js-intel-store** | File-backed intelligence memory (observations, receipts, reports, beliefs, …) |
| **CLI `jea`** | Operator entry: single runs, daemon, channel, data, audit |

Typical use: let an AI subject investigate, edit code, simulate, and prepare releases in a **lane worktree** or external resources, while persisting reports, verification, and evolution diaries each cycle for human review or channel interaction (e.g. Feishu).

---

## Features

- **Cyber-Taoist goal self-correction** — Phase 4/4.5 detects law lag from transaction feedback and mechanically applies `goal_patches` ([Core innovation](#core-innovation-goal-self-correction))
- **Full evolution pipeline** — Intel → Exec → Verify → Belief Update → Goals Assess/Calibrate → Evolution Diary
- **Subject isolation** — parallel subjects with separate namespaces, policies, lanes, and runtime data
- **Daemon step mode** — event-driven step-level evolution; `continuous` / `on_demand`
- **Human approval and soft intent** — Brief (next-cycle intent) + `approval_granted` (hard gate)
- **Beliefs and goals** — formal update paths for testable hypotheses and goal trees
- **Multiple agent backends** — DeepSeek, Claude Agent SDK, Cursor SDK, Reasonix CLI, …
- **Channel (Feishu)** — inbound classification, presence expression, control actions (evolution mode, cycle request, …)
- **Evolution Viewer** — local Web UI for rounds, reports, daemon state, observability

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                         jea CLI / Daemon                         │
├──────────────┬──────────────────────┬───────────────────────────┤
│  Cycle Domain │    Channel Domain     │   Evolution Viewer (web)  │
│  intel→exec→  │  classifier→presence  │   rounds / reports / SSE  │
│  verify→…     │  →speech→outbox       │                           │
├──────────────┴──────────────────────┴───────────────────────────┤
│  src/engine/ (OADA)  │  src/actions/  │  src/intelligence/       │
│  queue · exec ·       │  agent_run ·   │  store · reports ·       │
│  verifyActions       │  lane · gates  │  beliefs · goals           │
├──────────────────────┴────────────────┴───────────────────────────┤
│  policies/authority/  +  runtime/subjects/<ns>/SUBJECT.md         │
│  runtime/subjects/<ns>/data/  (evolution · intelligence · goals)  │
└─────────────────────────────────────────────────────────────────┘
```

Per-cycle pipeline (default **`reactor`**):

```text
Phase 1   reactor (claim evidence batch → investigate → host Seen → report → Decide)
Phase 2   exec (consume pending_decisions; Cycle Journal shares sibling action notes; carryover v2 + suggestion coverage survive into diary)
Phase 3   verify (mechanical + semantic)
Phase 3.5 belief_update
Phase 4   goals assess
Phase 4.5 goals calibrate
Phase 5   evolution diary
```

`phases` (classic observe → report → decide Phase 1) remains available as a deprecated fallback via `--pipeline phases` / `JEA_CYCLE_PIPELINE=phases`.

---

## Requirements

- **Node.js** ≥ 20
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

## Evolution cycle

**Single-round debugging** — local validation and troubleshooting:

```bash
jea run [--mock | --deepseek] [--subject NAME]
jea run --skip-goals-assess      # skip Phase 4/4.5
jea run --skip-belief-update     # skip Phase 3.5
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
jea beliefs show
jea goals show
```

Full CLI reference: [AGENTS.md](./AGENTS.md) (Chinese operator manual).

---

## Subjects and multi-subject

Each **Subject** is an independent evolution unit: its own policy, data namespace, optional lane (target-repo worktree), and channel config.

```text
runtime/subjects/
├── registry.json              # local registry (gitignored — do not commit)
└── <data_namespace>/
    ├── SUBJECT.md             # governance (boundaries, approval rules)
    ├── SOUL.md                # channel persona (not Decide authority)
    └── data/
        ├── evolution/
        ├── intelligence/
        └── goals/
```

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

The daemon drives evolution at **step granularity** — recommended for unattended long runs.

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
| `continuous` (default) | Heartbeat tick reconciles; opens new cycles when none are open |
| `on_demand` | Only explicit requests (`jea daemon cycle request`, operator brief, …) |

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

Inbound messages are batch-classified (**classifier**): approval intent, verification requests, operator facts, control commands, observations, … **Presence** produces speech in two stages and enqueues outbox.

Channel cannot bypass approval for publish or credentials; remote publish still follows brief → Decide → `approval_granted`.

---

## Evolution Viewer

Local Web UI; by default tracks all registered subjects:

```bash
npm run viewer:serve
# or
jea intel viewer serve [--port 8787] [--open]
```

- **Ops Home** — KPIs, attention items, open cycles, event stream
- **Reading view** — reports, diary, diagnostics, observability per cycle
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
| **Intent** | What to focus on next cycle (not fact) | `jea intel brief put` |
| **Fact** | Operator-confirmed, promotable to Seen | `operator_fact` via `jea intel ingest` |
| **Evidence** | External observations that can be overturned | `jea intel ingest` / inbox, probes |

**Actions (hard gates)** like `approval_granted` are produced by Decide and executed in Phase 2; operators should not edit `pending_decisions.json` directly.

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
| `JEA_LANGUAGE` | UI/report language: `zh-CN` \| `en-US` |
| `JEA_APPROVAL_MODE` | `manual` \| `auto_guarded` \| `auto_all` |
| `JEA_EVOLUTION_MODE` | Default daemon evolution mode |
| `JEA_AGENT_PROVIDER` | Default agent backend |
| `JEA_EXEC_AGENT_BUDGET` | Max `agent_run` decisions consumed per exec phase (default 8); mechanical actions uncapped |
| `JEA_AGENT_MAX_CONCURRENCY` | Max parallel `agent_run` width per wave (default 2) |
| `JEA_AGENT_MAX_ATTEMPTS` | Failures before `blocked` (default 2) |
| `JEA_EXEC_LIMIT` | Deprecated alias for `JEA_EXEC_AGENT_BUDGET` |

Feishu per-subject credentials: `JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID`, etc. — see `.env.example` and `policies/subjects.example.json`.

Override authority docs directory:

```bash
CYBER_TAOIST_DOCS_DIR=/path/to/custom-authority jea run
```

---

## Safety boundaries

- Phase 1 by default **records** observations, probe proposals, retrospectives, and receipts — it does not modify engine source, authority docs, or intel-store itself.
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

`jea audit queue` inspects evolution evidence / the decision queue. It is **not** the npm supply-chain audit (`npm run audit:ci`).

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
