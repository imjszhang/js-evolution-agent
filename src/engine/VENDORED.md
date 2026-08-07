# Vendored JEA engine (from js-evolution-engine)

Source originally vendored from [js-evolution-engine](https://github.com/imjszhang/js-evolution-engine) **v0.2.0**.

- **Vendored on:** 2026-06-13
- **Upstream path:** `../js-evolution-engine/src/`
- **JEA entry:** [`index.mjs`](index.mjs) — host-facing facade; internal modules live under this directory.

Host-specific extensions (unified `DecisionQueue`, `setCycleId`, etc.) are maintained in-tree. Cherry-pick upstream fixes manually when needed.

## Pruned unused surface (dead-code cleanup)

Removed from this tree because JEA never wired them:

- `cli/oada.mjs` (standalone oada CLI; JEA uses `jea`)
- `github/issues.mjs` and ExecutionPipeline `source: 'github'` mode
- Classic `pipelines/intel.mjs` (`IntelligencePipeline`) and `pipelines/verify.mjs` (`VerifyPipeline`); JEA uses conversational/agent_loop + `verifyActions`
- `act/exec-git.mjs` (unused; host lane has its own git helpers)
- `observe/query-resolver.mjs` and `observe/observation-registry.mjs` (unused by `AIDrivenObserver`)
