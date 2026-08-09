import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, writeJson } from '../../infra/json-store.mjs';
import { decisionFingerprint } from '../../intelligence/decision-queue.mjs';
import {
  reactorDir,
  shadowDecisionsPath,
  shadowReportPath,
  shadowReportsDir,
  shadowRunsPath,
} from './paths.mjs';

function emptyShadowDecisions() {
  return { decisions: [], updated_at: null };
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function appendShadowRun(dataRoot, record) {
  const file = shadowRunsPath(dataRoot);
  ensureDir(file);
  mkdirSync(reactorDir(dataRoot), { recursive: true });
  appendFileSync(file, `${JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  })}\n`, 'utf8');
}

export function readShadowRuns(dataRoot, { limit = 50 } = {}) {
  const file = shadowRunsPath(dataRoot);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // tolerate corrupt
      }
    }
    return rows.slice(-Math.max(0, limit));
  } catch {
    return [];
  }
}

export function writeShadowReport(dataRoot, batchId, markdown) {
  mkdirSync(shadowReportsDir(dataRoot), { recursive: true });
  const file = shadowReportPath(dataRoot, batchId);
  writeFileSync(file, String(markdown || ''), 'utf8');
  return file;
}

export function readShadowDecisions(dataRoot) {
  const raw = readJson(shadowDecisionsPath(dataRoot), emptyShadowDecisions());
  return {
    decisions: Array.isArray(raw?.decisions) ? raw.decisions : [],
    updated_at: raw?.updated_at ?? null,
  };
}

export function appendShadowDecisions(dataRoot, {
  batchId,
  subject = null,
  actions = [],
  analysis = null,
} = {}) {
  mkdirSync(reactorDir(dataRoot), { recursive: true });
  const file = shadowDecisionsPath(dataRoot);
  ensureDir(file);
  const current = readShadowDecisions(dataRoot);
  const recordedAt = new Date().toISOString();
  const added = [];
  for (const [index, action] of (actions || []).entries()) {
    const decision = {
      id: `${batchId}:${index}`,
      batch_id: batchId,
      subject,
      status: 'shadow',
      created_at: recordedAt,
      fingerprint: decisionFingerprint(action),
      action,
    };
    added.push(decision);
    current.decisions.push(decision);
  }
  writeJson(file, {
    decisions: current.decisions,
    updated_at: recordedAt,
    last_batch_id: batchId,
    last_analysis: analysis,
  });
  return added;
}
