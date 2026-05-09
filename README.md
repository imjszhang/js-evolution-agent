# js-evolution-agent

Updated: 2026-05-09 14:52:30 +08:00

`js-evolution-agent` is a controlled self-evolution host instance. It reuses `js-evolution-engine` as the OADA runtime, reads Cyber-Taoist documents as authoritative context, and stores local intelligence through `js-intel-store`.

## Architecture

- `js-evolution-engine`: engine, pipelines, action registry, decision queue, verification helpers.
- `examples/cyber-taoist-demo/cyber-taoist-docs`: read-only `CONSTITUTION.md` and `SKILL.md` context.
- `js-intel-store`: file-backed intelligence memory under `data/intelligence`.
- `js-evolution-agent`: host adapter, local policy, controlled action handlers, CLI, reports, and runtime data.

## Install

```powershell
cd D:\github\My\js-evolution-agent
npm install
```

The local dependencies are declared with `file:` links:

- `file:../js-evolution-engine`
- `file:../js-intel-store`

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
- `jea data reset [--yes]`: remove local runtime data.
- `jea subject show`: show the current Subject and Core Layer from `policies/project-guidance.md`.
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

By default, `oada.config.mjs` reads:

- `../js-evolution-engine/examples/cyber-taoist-demo/cyber-taoist-docs/CONSTITUTION.md`
- `../js-evolution-engine/examples/cyber-taoist-demo/cyber-taoist-docs/SKILL.md`
- `policies/project-guidance.md`

To use a different Cyber-Taoist docs directory:

```powershell
$env:CYBER_TAOIST_DOCS_DIR = 'D:\path\to\cyber-taoist-docs'
jea run
```

## Runtime Data

`data/evolution` and `data/intelligence` are local runtime state. If you change the evolution subject in `policies/project-guidance.md`, reset data so the next cycle does not reuse old memory:

```powershell
jea data reset --yes
```

This deletes `data/evolution`, `data/intelligence`, and `data/goals` if present. It does not delete `.env` or source files.

`js-intel-store` writes these sources under `data/intelligence`:

- `intel_observations`: daily JSONL observations.
- `evolution_events`: append-only evolution event log.
- `retrospectives`: append-only reviews.
- `latest_review`: latest review JSON.
- `action_receipts`: receipts from controlled handlers.
- `probe_threads`: per-probe event streams.

## Safety Boundary

The first phase only records observations, probe proposals, retrospectives, receipts, and local verification reports. It does not modify `js-evolution-engine`, `js-intel-store`, or Cyber-Taoist documents. Core-layer actions are recorded as human-review requests only.

## Test

```powershell
npm test
```

