# S8 生产灰度操作手册

日期：2026-08-15

S8 已把 `JEA_EVIDENCE_WAKE` / `JEA_QUEUE_DISABLE_CYCLE_TTL` / `JEA_EXEC_RATE_ONLY` / `JEA_IN_PROCESS_CYCLE` 默认打开。Cloud / CI 用隔离验证替代三生产 subject 一周观察。本手册只给操作者本机 `~/.jea` 加固。

## 隔离验收（合并门）

```bash
npm run reactor:canary
npx vitest run test/contracts.test.mjs test/exec-recovery.test.mjs \
  test/reactor-wake.test.mjs test/reactor-shadow.test.mjs \
  test/reactor-event-driven.test.mjs test/reactor-health.test.mjs \
  test/reactor-feature-gates.test.mjs
export JEA_HOME=$(mktemp -d)
npm run jea -- subject init s8-bot --use
npm run jea -- data init --all --subject s8-bot
npm run jea -- run --mock --subject s8-bot
node scripts/reactor-s8-promote-check.mjs --subject s8-bot
```

晋升闸必须 `ok: true`：无 duplicate wake/intent、`pending_verify=0`、`uncertain=0`、`health.ok`、reconcile 无 contract error。

回滚演练（S8 仍保留列车）：

```bash
JEA_EVIDENCE_WAKE=0 JEA_QUEUE_DISABLE_CYCLE_TTL=0 JEA_EXEC_RATE_ONLY=0 \
  JEA_IN_PROCESS_CYCLE=0 \
  npm run jea -- run --mock --pipeline agent_loop --subject s8-bot
```

unset 不再回退——默认已开，必须显式 `=0`。

## 生产 subject 顺序（可选）

`feishu-flow-test` → `js-evolution-agent` → `agentank-tank`

每级：

1. `jea data backup --subject NAME`
2. 确认默认 gate 已开，或只对该 daemon 进程导出 env
3. `jea daemon work --once --subject NAME` 或启动 worker
4. `node scripts/reactor-s8-promote-check.mjs --subject NAME`
5. 通过后再升下一级

回滚该 subject：对该 daemon 设 `JEA_EVIDENCE_WAKE=0` 等，或 registry `"evolution": { "pipeline": "agent_loop" }`。
