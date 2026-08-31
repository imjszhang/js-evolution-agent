import { join } from 'node:path';

export function reactorDir(dataRoot) {
  return join(dataRoot, 'evolution', 'reactor');
}

export function claimsPath(dataRoot) {
  return join(reactorDir(dataRoot), 'claims.json');
}

export function shadowDecisionsPath(dataRoot) {
  return join(reactorDir(dataRoot), 'shadow_decisions.json');
}

export function shadowRunsPath(dataRoot) {
  return join(reactorDir(dataRoot), 'shadow-runs.jsonl');
}

export function shadowReportsDir(dataRoot) {
  return join(reactorDir(dataRoot), 'shadow-reports');
}

export function shadowReportPath(dataRoot, batchId) {
  return join(shadowReportsDir(dataRoot), `${batchId}.md`);
}

export function activationLedgerDeltasPath(dataRoot) {
  return join(reactorDir(dataRoot), 'activation-ledger.deltas.jsonl');
}

export function evidenceRouterCursorPath(dataRoot) {
  return join(reactorDir(dataRoot), 'router-cursor.json');
}

export function reactorProgressSnapshotPath(dataRoot) {
  return join(reactorDir(dataRoot), 'progress-snapshot.json');
}
