import { describe, expect, it } from 'vitest';
import {
  buildIntelReport,
  buildMemoryAdmission,
  gatherReportContext,
} from '../src/intelligence/report-builder/index.mjs';
import { SseHub } from '../src/intelligence/evolution-viewer/sse.mjs';
import { createViewerApiServer } from '../src/intelligence/evolution-viewer/server.mjs';
import { createEvolutionEventsTailer } from '../src/intelligence/evolution-viewer/tailers.mjs';
import { createRuntimeWatcher } from '../src/intelligence/evolution-viewer/watcher.mjs';

describe('report builder and viewer split facades', () => {
  it('exposes context, standing-memory, render, and viewer api boundaries', () => {
    expect(typeof gatherReportContext).toBe('function');
    expect(typeof buildMemoryAdmission).toBe('function');
    expect(typeof buildIntelReport).toBe('function');
    expect(typeof SseHub).toBe('function');
    expect(typeof createViewerApiServer).toBe('function');
    expect(typeof createEvolutionEventsTailer).toBe('function');
    expect(typeof createRuntimeWatcher).toBe('function');
  });
});
