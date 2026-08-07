#!/usr/bin/env node
import { runChannelAgentRunTask } from '../src/channel/agent-runner.mjs';
import { runChannelNotifyTask } from '../src/channel/tasks.mjs';
import { getProjectRoot, loadProjectEnv } from '../src/infra/project.mjs';

const root = getProjectRoot();
loadProjectEnv(root);

const subject = process.argv.includes('--subject')
  ? process.argv[process.argv.indexOf('--subject') + 1]
  : 'agentank-tank';

const now = new Date().toISOString();

// Simulate an agent receipt that follows the new deliverable contract.
const receipt = {
  status: 'completed',
  summary: 'channel deliverable pipeline e2e',
  deliverable: {
    type: 'document',
    title: 'Channel 交付物管线 E2E 验证',
    content: [
      '# Channel 交付物管线 E2E 验证',
      '',
      '本文档由新的 channel agent run 交付物管线生成，验证以下链路：',
      '',
      '## 链路',
      '',
      '1. agent receipt 声明 deliverable 契约（type/title/content/summary）',
      '2. persistChannelDeliverable 解析契约并写入 .md + 情报索引',
      '3. delivery renderer 按 type=document 路由为 document delivery item',
      '4. feishu adapter 创建云文档并向操作者发送链接',
      '',
      '## 说明',
      '',
      '操作者现在收到的是人类可读的飞书文档，而不是系统 JSON receipt。',
      '',
      '```text',
      'deliverable.type = document',
      'medium = document',
      '```',
      '',
      `验证时间：${now}`,
    ].join('\n'),
    summary: 'Channel 交付物管线已打通：人话文档而非 JSON',
    reason: 'complex verification report warrants a document',
  },
  sources: [
    { file: 'src/channel/delivery-renderer.mjs', what: 'delivery item 路由' },
    { file: 'src/channel/deliverable.mjs', what: 'deliverable 契约解析' },
  ],
  confidence: 0.9,
  follow_up_hint: '如需把这套契约接入真实 provider，确认 JEA_AGENT_PROVIDER 配置',
};

console.log(JSON.stringify({ phase: 'agent_run', subject }, null, 2));
const runResult = await runChannelAgentRunTask(root, subject, {
  request: {
    channel_agent_run_id: `e2e-pipeline-${now.replace(/[:.]/g, '-')}`,
    objective: '验证 channel 交付物管线',
    mode: 'observe',
    permission_profile: 'read_only',
  },
  mock_result: {
    success: true,
    status: 'completed',
    provider: 'mock',
    message: receipt.summary,
    agent: { raw_response: JSON.stringify(receipt) },
  },
});

console.log(JSON.stringify({
  phase: 'persisted',
  ok: runResult.ok,
  deliverable_type: runResult.deliverable?.type,
  deliverable_id: runResult.deliverable?.deliverable_id,
  md_path: runResult.deliverable?.md_path,
  dispatch: runResult.dispatch,
}, null, 2));

console.log(JSON.stringify({ phase: 'notify_flush' }, null, 2));
const notify = await runChannelNotifyTask(root, subject, { limit: 5 });
console.log(JSON.stringify({
  phase: 'done',
  sent: notify.sent.map((entry) => ({ target: entry.target, result: entry.result })),
  failed: notify.failed,
}, null, 2));
