import { getProjectRoot } from '../utils/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import {
  formatOperatorQuestionsForPrompt,
  operatorQuestionDisplayName,
  pendingOperatorQuestionsDir,
  readPendingOperatorQuestions,
  readResolvedOperatorQuestions,
  resolveOperatorQuestion,
  resolvedOperatorQuestionsDir,
} from '../../intelligence/operator-questions.mjs';

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function printQuestionList(title, runtime, readResult, { resolved = false, verbose = false } = {}) {
  console.log(`# ${title}`);
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`dir: ${resolved ? resolvedOperatorQuestionsDir(runtime.runtimeRoot) : pendingOperatorQuestionsDir(runtime.runtimeRoot)}`);
  console.log('');
  if (!readResult.questions.length) {
    console.log('(none)');
    return;
  }
  for (const question of readResult.questions) {
    console.log(`- ${operatorQuestionDisplayName(question)}`);
    console.log(`  trigger=${question.trigger ?? 'unknown'} created_at=${question.created_at}`);
    if (question.origin_fact_id) {
      console.log(`  origin_fact_id=${question.origin_fact_id}`);
    }
    if (question.resolved_at) {
      console.log(`  resolved_at=${question.resolved_at} resolution=${question.resolution ?? 'unknown'}`);
    }
    if (verbose) {
      console.log(formatOperatorQuestionsForPrompt([question]).split('\n').map((line) => `  ${line}`).join('\n'));
    }
  }
  if (readResult.invalid?.length) {
    console.log('');
    console.log(`invalid: ${readResult.invalid.length}`);
  }
}

export function questionList({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = readPendingOperatorQuestions(runtime.runtimeRoot, {
    limit: numberFlag(flags, 'limit', 20),
  });
  if (flags.json) {
    console.log(JSON.stringify({ runtime, ...result }, null, 2));
  } else {
    printQuestionList('Pending Operator Questions', runtime, result, {
      verbose: Boolean(flags.verbose),
    });
  }
  return result.invalid.length ? 1 : 0;
}

export function questionResolved({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = readResolvedOperatorQuestions(runtime.runtimeRoot, {
    limit: numberFlag(flags, 'limit', 20),
  });
  if (flags.json) {
    console.log(JSON.stringify({ runtime, ...result }, null, 2));
  } else {
    printQuestionList('Resolved Operator Questions', runtime, result, {
      resolved: true,
      verbose: Boolean(flags.verbose),
    });
  }
  return result.invalid.length ? 1 : 0;
}

export function questionResolve({ root = getProjectRoot(), flags = {}, args = [] } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const questionId = flags.id || args[0];
  if (!questionId || typeof questionId !== 'string') {
    console.error('Usage: jea intel question resolve <id> [--note TEXT] [--json]');
    return 2;
  }
  try {
    const result = resolveOperatorQuestion(runtime.runtimeRoot, questionId, {
      resolution: flags.resolution || 'acknowledged',
      resolvedBy: flags.by || 'operator',
      note: flags.note || null,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`resolved operator question ${questionId} -> ${result.to}`);
    return 0;
  } catch (e) {
    console.error(`Failed to resolve operator question: ${e.message}`);
    return 1;
  }
}

export async function intelQuestionCommand({ root = getProjectRoot(), action, flags = {}, args = [] } = {}) {
  if (action === 'list' || !action) return questionList({ root, flags });
  if (action === 'resolved') return questionResolved({ root, flags });
  if (action === 'resolve') return questionResolve({ root, flags, args });
  console.error('Usage: jea intel question <list|resolved|resolve> [id] [--json] [--limit N]');
  return 2;
}
