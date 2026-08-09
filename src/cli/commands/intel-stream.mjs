import { getProjectRoot } from '../../infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import {
  readEvidenceStream,
  reconcileEvidenceStream,
} from '../../intelligence/evidence-stream.mjs';
import { EVIDENCE_SOURCE_KINDS } from '../../contracts/evidence-envelope.mjs';

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

function numberFlag(flags, name, fallback = null) {
  if (flags[name] == null || flags[name] === true) return fallback;
  const n = Number(flags[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function parseKinds(flags = {}) {
  const raw = flags.kind ?? flags.kinds ?? null;
  if (raw == null || raw === true) return null;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function printReconcile(runtime, report) {
  console.log('# Evidence stream reconcile');
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`dataRoot: ${runtime.dataRoot}`);
  console.log(`ok: ${report.ok}`);
  console.log(`total: ${report.total}`);
  console.log(`contract_errors: ${report.contract_error_count}`);
  console.log(`duplicate_ids: ${report.duplicate_ids.length}`);
  console.log('');
  console.log('sources:');
  for (const source of report.sources) {
    const mark = source.ok ? 'ok' : 'MISMATCH';
    console.log(`  - ${source.kind}: disk=${source.disk} stream=${source.stream} [${mark}]`);
  }
  if (report.mismatched.length) {
    console.log('');
    console.log('mismatched kinds:');
    for (const source of report.mismatched) {
      console.log(`  - ${source.kind}: disk=${source.disk} stream=${source.stream}`);
    }
  }
  if (report.duplicate_ids.length) {
    console.log('');
    console.log('duplicate ids:');
    for (const row of report.duplicate_ids.slice(0, 20)) {
      console.log(`  - ${row.key} (count=${row.count})`);
    }
  }
  if (report.contract_errors.length) {
    console.log('');
    console.log('contract errors (first 20):');
    for (const err of report.contract_errors.slice(0, 20)) {
      console.log(`  - ${err.kind}:${err.id}: ${(err.errors || []).join('; ')}`);
    }
  }
}

function printStream(runtime, envelopes, { limit }) {
  console.log('# Evidence stream');
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`dataRoot: ${runtime.dataRoot}`);
  console.log(`count: ${envelopes.length}${limit != null ? ` (limit=${limit})` : ''}`);
  console.log(`kinds: ${EVIDENCE_SOURCE_KINDS.join(', ')}`);
  console.log('');
  if (!envelopes.length) {
    console.log('(none)');
    return;
  }
  for (const envelope of envelopes) {
    const cycle = envelope.cycle_id ? ` cycle=${envelope.cycle_id}` : '';
    console.log(
      `- [${envelope.occurred_at}] ${envelope.kind}/${envelope.type} id=${envelope.id}${cycle}`,
    );
  }
}

export async function intelStreamCommand({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const dataRoot = runtime.dataRoot;

  if (flags.reconcile) {
    const report = reconcileEvidenceStream(dataRoot);
    if (flags.json) {
      console.log(JSON.stringify({ runtime: {
        subject: runtime.subject,
        dataNamespace: runtime.dataNamespace,
        dataRoot: runtime.dataRoot,
      }, report }, null, 2));
    } else {
      printReconcile(runtime, report);
    }
    return report.ok ? 0 : 1;
  }

  const limit = numberFlag(flags, 'limit', null);
  const envelopes = readEvidenceStream(dataRoot, {
    since: typeof flags.since === 'string' ? flags.since : null,
    limit,
    kinds: parseKinds(flags),
    cycleId: typeof flags.cycle === 'string' ? flags.cycle : null,
  });

  if (flags.json) {
    console.log(JSON.stringify({
      runtime: {
        subject: runtime.subject,
        dataNamespace: runtime.dataNamespace,
        dataRoot: runtime.dataRoot,
      },
      count: envelopes.length,
      envelopes,
    }, null, 2));
    return 0;
  }

  printStream(runtime, envelopes, { limit });
  return 0;
}
