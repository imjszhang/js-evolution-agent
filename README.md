# js-evolution-agent

Updated: 2026-05-10 22:44:39 +08:00

`js-evolution-agent` is a controlled self-evolution host instance. It reuses `js-evolution-engine` as the OADA runtime, reads Cyber-Taoist documents as authoritative context, and stores local intelligence through `js-intel-store`.

## Architecture

- `js-evolution-engine`: engine, pipelines, action registry, decision queue, verification helpers.
- `policies/authority/`: read-only `CONSTITUTION.md` and `GUIDE.md` authority context (project-local).
- `js-intel-store`: file-backed intelligence memory under `runtime/subjects/<data_namespace>/data/intelligence`.
- `js-evolution-agent`: host adapter, local policy, controlled action handlers, CLI, reports, and runtime data.

## Install

```powershell
cd D:\github\My\js-evolution-agent
npm install
```

Runtime libraries are consumed from npm (`js-evolution-engine`, `js-intel-store`); `npm install` is enough after cloning.

## CLI

Use `jea` as the project operator CLI:

```powershell
npm run jea -- help
npm run doctor
npm start
```

After package bin links are installed, direct usage is also available:

```powershell
jea doctor
jea run --mock
jea data status
```

First-version commands:

- `jea doctor`: check Node, dependencies, `.env`, DeepSeek config, docs, and config files.
- `jea run [--mock] [--deepseek]`: run the full `intel -> exec -> verify -> intelligence receipts` loop.
- `jea data status`: show runtime data file counts and latest files.
- `jea data status --json`: show runtime data status as machine-readable JSON.
- `jea data init`: create runtime data directories without deleting history.
- `jea data init --all`: create the default goals template and append seed intelligence.
- `jea data backup [--name NAME]`: back up the active subject runtime data to `backups/subjects/<data_namespace>/`.
- `jea data reset [--yes]`: remove local runtime data.
- `jea intel summary [--days N] [--limit N]`: show recent intelligence memory.
- `jea intel report`: print the latest human-readable intel report (Markdown) for the active subject.
- `jea intel report list [--limit N]`: list recent intel reports with cycle id, time, and TL;DR.
- `jea intel report --cycle <id>`: print the report for a specific cycle.
- `jea intel report --open`: open the latest report in the OS default viewer (`open` on macOS, `xdg-open` on Linux, `start` on Windows).
- `jea intel report --json`: print the index record (not the MD body) as JSON.
- `jea intel ingest --source NAME [--file PATH | --stdin] [--json]`: ingest one or more JSON records directly into the active subject intelligence store. `entity_jsonl` sources (e.g. `probe_threads`) require `_entity_id` on every record.
- `jea intel inbox put --source NAME [--file PATH | --stdin] [--name LABEL]`: queue records as a JSON payload under `runtime/subjects/<ns>/data/intelligence/_inbox/` for later draining; useful when external collectors drop files for the agent to pick up.
- `jea intel inbox drain [--dir PATH] [--json]`: drain queued `_inbox` files into the intelligence store; unknown source or invalid files are kept and reported as failures (exit code 1).
- `jea daemon status [--all | --subjects a,b] [--json]`: show daemon worker, queue, health, lock, and latest event summaries across one or more subjects.
- `jea daemon doctor [--all | --subjects a,b] [--json]`: diagnose daemon health for one or more subjects.
- `jea daemon events [--all | --subjects a,b] [--limit N] [--json]`: show recent daemon/task lifecycle events.
- `jea daemon tasks list [--all | --subjects a,b] [--status STATUS] [--json]`: list daemon tasks across subjects. Task `inspect` / `retry` / `cancel` remain single-subject operations.
- `jea daemon inbox [--all | --subjects a,b] [--json]`: show the latest intel report, evolution diary, verify report, standing memory marker, and health attention summary for each subject.
- `jea daemon stop [--all | --subjects a,b]`: request graceful stop for selected subject workers. `daemon start` and `daemon work --once` remain one-subject-per-process so external orchestrators can run subjects in parallel.
- `jea audit queue`: check decision queue health, unknown actions, and stale in-progress work.
- `jea llm ping [--mock]`: test DeepSeek or local MockAIClient connectivity.
- `jea policy check`: verify required active subject policy sections.
- `jea subject list`: list configured subject policies.
- `jea subject show`: show the active Subject, Core Layer, namespace, and runtime paths.
- `jea subject init <name> [--use]`: create a new subject policy from the project template.
- `jea subject use <name>`: switch the active subject policy.
- `jea subject check`: validate the active subject policy.
- `jea actions list`: list registered action types.
- `jea actions check`: check queued decisions for unknown action types.

Legacy scripts are kept:

```powershell
npm run intel
npm run exec
npm run decisions
npm run reset-data
```

## AI Driver

This project uses [DeepSeek's OpenAI-compatible Chat Completions API](https://api-docs.deepseek.com/zh-cn/) when `DEEPSEEK_API_KEY` is set. Implementation: `src/ai/deepseek-client.mjs` (`openai` SDK + `dotenv`).

1. Copy the example env file and fill in your key:

   ```powershell
   copy .env.example .env
   ```

2. Edit `.env`:

   - `DEEPSEEK_API_KEY`: required for real calls; if missing, `oada.config.mjs` falls back to `MockAIClient`.
   - `DEEPSEEK_BASE_URL`: default `https://api.deepseek.com`.
   - `DEEPSEEK_MODEL`: default `deepseek-v4-flash`.
   - `DEEPSEEK_THINKING`: optional, `enabled` / `true` / `1`.
   - `DEEPSEEK_REASONING_EFFORT`: optional, for example `high`.

3. Run:

   ```powershell
   jea run --deepseek
   ```

## Context Documents

By default, `oada.config.mjs` reads Cyber-Taoist Markdown from this repository's `policies/authority/`, plus:

- the subject policy selected by `JEA_SUBJECT`, `--subject`, or `policies/subjects.json` default

`policies/project-guidance.md` is kept as a compatibility entry. New subject policies live under `policies/subjects/`.

To override the authority docs directory:

```powershell
$env:CYBER_TAOIST_DOCS_DIR = 'D:\path\to\custom-authority-docs'
jea run
```

## Subjects

Cyber-Taoist analysis requires a defined subject. `js-evolution-agent` manages subjects as policy files:

```text
policies/
  subjects.json
  subjects.example.json
  subjects/
    js-evolution-agent.md
  templates/
    project.md
```

`policies/subjects.json` registers known subjects and optional `default_subject` for interactive CLI convenience. It may also carry structured `lane` and `resources` fields for machine-readable repo, branch, command, resource-root, and resource-rule configuration. Use `policies/subjects.example.json` as the copyable shape for those fields.

`policies/subjects.json`, legacy `policies/active-subject.json`, and `policies/subjects/*.md` are local state and are ignored by Git by default. Commit examples, templates, and stable project defaults, not operator-specific registry files. `policies/project-guidance.md` remains the committed compatibility/default policy.

Common commands:

```powershell
jea subject list
jea subject show
jea subject show --subject agentank-tank
jea subject init my-product
jea subject use my-product
jea subject check
jea run --subject agentank-tank
```

Each subject owns a separate data namespace under `runtime/subjects/<data_namespace>/`. After creating or selecting a subject, initialize that subject runtime before running:

```powershell
jea data init --all
```

## Multi-Subject Daemon Operations

Subjects are independent evolution units. Run one daemon worker process per subject when you want parallel evolution, and use the multi-subject daemon views to supervise them:

```powershell
# External orchestrators can start these as separate foreground worker processes.
jea daemon start --subject subject-a
jea daemon start --subject subject-b

# Operator views aggregate state without serializing the subjects into one run.
jea daemon status --all
jea daemon doctor --all
jea daemon inbox --all
jea daemon tasks list --all --status failed
```

Operational commands stay conservative: `daemon stop --all` fans out graceful stop requests, while `daemon start`, `daemon work --once`, and task `inspect` / `retry` / `cancel` operate on a single subject at a time.

## Runtime Data

Runtime data is isolated by subject namespace:

```text
runtime/subjects/<data_namespace>/
  data/
    evolution/
    intelligence/
    goals/
```

`policies/subjects.json` registers subjects and optional `default_subject`. Explicit selection uses `--subject NAME` or `JEA_SUBJECT`. `jea run`, `jea data status/init/reset/backup`, `jea intel summary`, `jea audit queue`, and `jea actions check` resolve the subject through that order. Legacy `policies/active-subject.json` is still read when `subjects.json` is missing.

Use `init` for a non-destructive first setup:

```powershell
jea data init --all
```

This creates:

- `policies/subjects/` layout if needed and, when `--all` only: `policies/subjects.json` plus a localized `policies/subjects/js-evolution-agent.md` generated from `JEA_LANGUAGE` when that subject file is missing (same rules as `jea subject list`)

- `runtime/subjects/<data_namespace>/data/evolution`
- `runtime/subjects/<data_namespace>/data/intelligence`
- `runtime/subjects/<data_namespace>/data/goals`
- `runtime/subjects/<data_namespace>/data/goals/active_goals.json` when missing
- one initialization observation and one evolution event when `--seed` or `--all` is used

Useful variants:

```powershell
jea data init
jea data init --goals
jea data init --seed
jea data init --all --json
jea data backup --name before-subject-change
```

`init` does not delete history and does not overwrite existing files by default. Use `--force` only if you want to overwrite the default goals template.

If you change the active evolution subject, the next commands automatically read and write that subject namespace. `reset` only removes the current subject runtime data:

```powershell
jea data reset --yes
```

This deletes the current subject's `data/evolution`, `data/intelligence`, and `data/goals` if present. It does not delete `.env`, source files, or other subject namespaces.

The legacy top-level `data/` directory is still ignored for compatibility with older local runs, but it is no longer the default write target.

`js-intel-store` writes these sources under the current subject's `data/intelligence`:

- `intel_observations`: daily JSONL observations.
- `evolution_events`: append-only evolution event log.
- `retrospectives`: append-only reviews.
- `latest_review`: latest review JSON.
- `action_receipts`: receipts from controlled handlers.
- `probe_threads`: per-probe event streams.
- `intel_reports`: index of human-readable intel reports. Each cycle's report is written as Markdown under `data/intelligence/reports/<cycle_id>.md`; this jsonl stores the index (cycle_id, generated_at, md_path, tldr, source, language, action_count, evidence_obs_count, evidence_probe_count, evidence_retro_count).

After every successful Phase 1 (intel pipeline), a Phase 1.5 build step writes one free-form Markdown report per cycle. The report is intentionally **unconstrained**:

- The full text of `CONSTITUTION.md`, `GUIDE.md`, and the active subject policy is injected into the AI prompt. The model is free to choose structure, voice, length, and section names — it is asked only to be human-readable, faithful to Cyber-Taoist evolutionary thinking, and to not invent ids/counts beyond the cycle facts JSON.
- Output language is detected from the active subject policy (CJK ratio): primarily Chinese policies produce Chinese reports; otherwise English. The default is Chinese.
- `gatherEvidence` (recent `intel_observations` / `probe_results` / `retrospectives` / `evolution_events`) and `assessGoals` (deterministic bad-signal / good-signal token match) are still computed and passed to the prompt as auxiliary signals; the AI may use, override, or ignore them.
- When the AI client is missing or throws, the builder writes a minimal placeholder Markdown listing only mechanical facts (cycle id, action count, evidence counts) so `jea intel report` always has something to display. `source: 'fallback'` marks these.
- **Token cost**: injecting the full Cyber-Taoist documents materially increases prompt length; `jea run --deepseek` cycles take noticeably longer than before. The Phase 1.5 step is wrapped in try/catch and never blocks the main loop.
- There is currently **no machine-side schema enforcement** on the report body. Tools that previously parsed structured sections (`countProposedRevisions`, `extractEvidenceRefs`, `jea intel report doctor`) have been removed. Re-introducing a parseable channel for downstream goal-refinement is intentionally deferred.

## Inspection And Audit

Use these commands to inspect runtime state without mutating it:

```powershell
jea intel summary
jea intel summary --json
jea audit queue
jea audit queue --json
jea policy check
jea llm ping --mock
```

`jea llm ping` without `--mock` sends one short request to DeepSeek and never prints your API key.

## Safety Boundary

The first phase only records observations, probe proposals, retrospectives, receipts, and local verification reports. It does not modify `js-evolution-engine`, `js-intel-store`, or Cyber-Taoist documents. Core-layer actions are recorded as human-review requests only.

## Test

```powershell
npm test
```
