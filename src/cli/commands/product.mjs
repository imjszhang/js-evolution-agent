import { resolveSubjectFromFlags } from '../../infra/subjects.mjs';
import {
  PRODUCT_READINESS_SOURCE,
  readSubjectReadiness,
  readinessCodeView,
} from '../../product/subject-readiness.mjs';

export function productHelpText() {
  return [
    'Usage: jea product status [--json] [--subject NAME]',
    '       jea readiness [--json] [--subject NAME]',
    '',
    'Show aggregate product/Subject readiness: Web host, Cycle, Channel, model,',
    'and conversation. Codes match service.getReadiness. This is not `jea status`,',
    'which reports only the localhost Web host bind/pid.',
    '',
    'Subject resolution matches other domain commands: --subject NAME, JEA_SUBJECT,',
    'or the registry default subject.',
  ].join('\n');
}

export function productStatusPayload(context, flags = {}, { hostKind = 'electron' } = {}) {
  const config = resolveSubjectFromFlags(context.sourceRoot, flags);
  const readiness = readSubjectReadiness(context, config.name, { hostKind });
  return {
    source: PRODUCT_READINESS_SOURCE,
    host: 'cli',
    ...readiness,
  };
}

function printHuman(payload) {
  console.log(`# Product status: ${payload.subject}`);
  console.log(`source: ${payload.source}`);
  console.log(`web_host: ${payload.web_host.state} ${payload.web_host.reasons.join(',')}`);
  console.log(`cycle: ${payload.cycle.state} ${payload.cycle.reasons.join(',')}`);
  console.log(`channel: ${payload.channel.state} ${payload.channel.reasons.join(',')}`);
  console.log(`model: ${payload.model.state}/${payload.model.mode} ${payload.model.reasons.join(',')}`);
  console.log(`conversation: ${payload.conversation.state} ${payload.conversation.reasons.join(',')}`);
  console.log(`allowed_actions: ${payload.allowed_actions.join(',')}`);
}

export async function productStatusCommand({ flags = {}, context, hostKind = 'electron' }) {
  try {
    const payload = productStatusPayload(context, flags, { hostKind });
    if (flags.json) console.log(JSON.stringify(payload, null, 2));
    else printHuman(payload);
    return 0;
  } catch (error) {
    console.error(error?.message || String(error));
    return error?.code === 'NOT_FOUND' || error?.code === 'INVALID_REQUEST' ? 2 : 1;
  }
}

export async function productCommand({ subcommand, flags = {}, context }) {
  if (!subcommand || subcommand === 'help') {
    console.log(productHelpText());
    return subcommand === 'help' ? 0 : 2;
  }
  if (subcommand === 'status') {
    return productStatusCommand({ flags, context });
  }
  console.error(`Unknown product command: ${subcommand}`);
  console.log(productHelpText());
  return 2;
}

export { readinessCodeView };
