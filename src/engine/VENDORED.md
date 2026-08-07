# Vendored JEA engine (from js-evolution-engine)

Source originally vendored from [js-evolution-engine](https://github.com/imjszhang/js-evolution-engine) **v0.2.0**.

- **Vendored on:** 2026-06-13
- **Upstream path:** `../js-evolution-engine/src/`
- **JEA entry:** [`index.mjs`](index.mjs) — host-facing facade; internal modules live under this directory.

Host-specific extensions (unified `DecisionQueue`, `setCycleId`, etc.) are maintained in-tree. Cherry-pick upstream fixes manually when needed.

## Pruned unused surface (dead-code cleanup)

### Wave 1 — hard-dead

- `cli/oada.mjs` (standalone oada CLI; JEA uses `jea`)
- `github/issues.mjs` and ExecutionPipeline `source: 'github'` mode
- Classic `pipelines/intel.mjs` (`IntelligencePipeline`) and `pipelines/verify.mjs` (`VerifyPipeline`); JEA uses conversational/agent_loop + `verifyActions`
- `act/exec-git.mjs` (unused; host lane has its own git helpers)
- `observe/query-resolver.mjs` and `observe/observation-registry.mjs` (unused by `AIDrivenObserver`)

### Wave 2 — soft-dead / JEA-unreachable

- `EvolutionEngine.observeAnalyzeAndDecide` and classic PromptBuilder templates (`ai/prompt-builder.mjs`, `ai/prompts/*`); host prompts live in `src/prompts/`
- `analyze/analyzer.mjs` (`SelfAnalyzer`; constructed but never called)
- `decide/feature-request.mjs` and `act/modifier.mjs` (wired into `ctx` but no host handler consumed them)
- Engine builtin action types (`implement_feature`, etc.); JEA registers its own via `ActionTypeRegistry`
- `EvolutionEngine` is now a Phase 1 helper container (cycle id / rules / goals / guidance / logger); LLM calls stay in host pipelines
