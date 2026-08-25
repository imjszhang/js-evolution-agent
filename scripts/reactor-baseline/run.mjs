/**
 * Orchestrate isolated fixture generation + read-only baseline measurement (#209).
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { rebuildEvidenceJournal } from '../../src/evolution/reactor/evidence-journal-maintenance.mjs';
import {
  evidenceIndexPath,
  readEvidenceCursor,
} from '../../src/evolution/reactor/evidence-index.mjs';
import { resetEvidenceHealthSnapshotCache } from '../../src/intelligence/evidence-stream.mjs';
import { resetDaemonProjectionCache } from '../../src/daemon/daemon-projection.mjs';
import {
  BASELINE_ISSUE,
  BASELINE_PARENT_ISSUE,
  BASELINE_SCHEMA_VERSION,
  FIXTURE_NOW_ISO,
  FIXTURE_SEED,
  FIXTURE_SUBJECT,
  REACTORS,
} from './constants.mjs';
import { createIsolatedBaselineHome, generateBaselineFixture } from './fixture.mjs';
import {
  compareHandledCoverage,
  measureAttribution,
  measureProjection,
} from './measure.mjs';
import { existsSync, readFileSync, rmSync } from 'node:fs';

function realJeaHome(home = homedir()) {
  return resolve(home, '.jea');
}

function readGeneration(dataRoot) {
  const path = evidenceIndexPath(dataRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'))?.generation ?? null;
  } catch {
    return null;
  }
}

function cursorSnapshot(dataRoot) {
  const generation = readGeneration(dataRoot);
  return Object.fromEntries(REACTORS.map((reactor) => {
    const cursor = readEvidenceCursor(dataRoot, reactor, { generation });
    return [reactor, {
      offset: cursor.offset,
      generation: cursor.generation,
      initialized: cursor.initialized,
    }];
  }));
}

function isolationRecord(jeaHome, realHome) {
  const isolated = resolve(jeaHome) !== resolve(realHome)
    && !resolve(jeaHome).startsWith(`${resolve(realHome)}/`)
    && !resolve(jeaHome).startsWith(`${resolve(realHome)}\\`);
  return {
    isolated,
    jea_home: jeaHome,
    real_jea_home: realHome,
    read_real_jea_home: false,
    wrote_real_jea_home: false,
    network: false,
    llm: 'none',
    env_jea_home: process.env.JEA_HOME ?? null,
  };
}

function publicAttribution(measured) {
  return {
    authority: measured.authority,
    claimable: measured.claimable,
    populations: measured.populations,
    attribution: measured.attribution,
    claim_path: measured.claim_path,
    projected_vs_claimable: measured.projected_vs_claimable,
    amplification: measured.amplification,
  };
}

export async function runReactorBacklogBaseline({
  profile = 'smoke',
  seed = FIXTURE_SEED,
  rebuild = true,
  keep = false,
  nowIso = FIXTURE_NOW_ISO,
} = {}) {
  const realHome = realJeaHome();
  const isolated = createIsolatedBaselineHome({ realHome });
  const previousHome = process.env.JEA_HOME;
  process.env.JEA_HOME = isolated.jeaHome;
  resetEvidenceHealthSnapshotCache();
  resetDaemonProjectionCache();
  let cleanup = !keep;
  try {
    const fixture = generateBaselineFixture({
      sourceRoot: isolated.sourceRoot,
      jeaHome: isolated.jeaHome,
      profile,
      seed,
    });
    const dataRoot = fixture.runtime.dataRoot;
    const root = { sourceRoot: isolated.sourceRoot, jeaHome: isolated.jeaHome };
    const generationBefore = readGeneration(dataRoot);
    const cursorsBefore = cursorSnapshot(dataRoot);
    const before = measureAttribution(dataRoot);
    const projection = await measureProjection(root, FIXTURE_SUBJECT, dataRoot);

    let rebuildResult = {
      performed: false,
      handled_coverage: 'not_measured',
    };
    if (rebuild) {
      const rebuilt = await rebuildEvidenceJournal(dataRoot, {
        root: isolated.sourceRoot,
        subject: FIXTURE_SUBJECT,
        dryRun: false,
        force: true,
        assertStopped: () => ({ stopped: true, live: [] }),
      });
      resetEvidenceHealthSnapshotCache();
      const after = measureAttribution(dataRoot);
      const coverage = compareHandledCoverage(before, after, fixture.coverage);
      rebuildResult = {
        performed: true,
        status: rebuilt.status,
        generation_before: generationBefore,
        generation_after: readGeneration(dataRoot),
        cursor_before: cursorsBefore,
        cursor_after: cursorSnapshot(dataRoot),
        cursor_migration: rebuilt.cursor_migration ?? null,
        ...coverage,
      };
    }

    const report = {
      schema_version: BASELINE_SCHEMA_VERSION,
      issue: BASELINE_ISSUE,
      parent_issue: BASELINE_PARENT_ISSUE,
      measured_at: nowIso,
      isolation: isolationRecord(isolated.jeaHome, realHome),
      fixture: {
        profile,
        seed,
        subject: FIXTURE_SUBJECT,
        recipe: fixture.recipe,
        journal_bytes: fixture.journal_bytes,
        index_generation: fixture.index_generation,
        coverage: {
          marker_backed: fixture.coverage.marker_backed,
          covered_index_only: fixture.coverage.covered_index_only,
        },
        incident_shape: fixture.incident_shape,
      },
      ...publicAttribution(before),
      projection,
      rebuild: rebuildResult,
    };
    if (keep) {
      report.isolation.kept_source_root = isolated.sourceRoot;
      report.isolation.kept_jea_home = isolated.jeaHome;
      cleanup = false;
    }
    return report;
  } finally {
    resetEvidenceHealthSnapshotCache();
    resetDaemonProjectionCache();
    if (previousHome == null) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previousHome;
    if (cleanup) {
      rmSync(isolated.sourceRoot, { recursive: true, force: true });
      rmSync(isolated.jeaHome, { recursive: true, force: true });
    }
  }
}
