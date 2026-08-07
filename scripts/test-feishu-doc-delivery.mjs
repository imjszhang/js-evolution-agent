#!/usr/bin/env node
import { resolveFeishuConfig } from '../src/channel/adapters/feishu/config.mjs';
import { sendOutboundMessage } from '../src/channel/adapters/feishu/index.mjs';
import { normalizeOutboundMessage } from '../src/channel/types.mjs';
import { getProjectRoot, loadProjectEnv } from '../src/infra/project.mjs';

const root = getProjectRoot();
loadProjectEnv(root);
const subject = process.argv.includes('--subject')
  ? process.argv[process.argv.indexOf('--subject') + 1]
  : 'agentank-tank';

const cfg = resolveFeishuConfig(root, subject);
const target = cfg.defaultChatId || cfg.operatorBinding?.open_id;
if (!target) {
  console.error('No operator target (defaultChatId / operator binding)');
  process.exit(2);
}

const now = new Date().toISOString();
const markdown = [
  '# JEA Feishu document delivery test',
  '',
  'This is a live test of the Channel Deliverable Feishu document pipeline.',
  '',
  '## Checks',
  '',
  '1. Cloud document is created successfully',
  '2. Markdown body is written into the document',
  '3. Operator receives a Feishu message with the document link',
  '',
  '## Sample body',
  '',
  'Agent run output should be persisted locally as Markdown and mirrored to a Feishu doc.',
  '',
  '```text',
  'status: completed',
  'provider: manual_test',
  '```',
  '',
  `Test time: ${now}`,
].join('\n');

const outbound = normalizeOutboundMessage({
  channel: 'feishu',
  target,
  document: {
    title: 'JEA Feishu document delivery test',
    markdown,
    message_text: 'Deliverable ready: JEA Feishu document delivery test',
  },
  text: 'Deliverable ready: JEA Feishu document delivery test',
  subject,
  reason: 'manual_doc_delivery_test',
  idempotency_key: `manual-doc-test-${now.replace(/[:.]/g, '-')}`,
});

console.log(JSON.stringify({ phase: 'sending', subject, target }, null, 2));
const result = await sendOutboundMessage(outbound, { root, subject });
console.log(JSON.stringify({ phase: 'done', ok: true, result }, null, 2));
