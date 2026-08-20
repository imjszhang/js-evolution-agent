export type ParityMark = 'included' | 'legacy-only' | 'deferred'

export interface ParityInventoryItem {
  id: string
  feature: string
  mark: ParityMark
  notes: string
}

/**
 * Legacy Evolution Viewer → 0.1.0 Inspector inventory.
 * Deferred items are not removed; they remain in the standalone Viewer.
 */
export const EVOLUTION_PARITY_INVENTORY: ParityInventoryItem[] = [
  { id: 'current-open-cycle', feature: 'Show current/open cycle when one exists', mark: 'included', notes: 'Prefers list/cycle-state status or cycle_diagnostics.recent; never attention.cycle_id.' },
  { id: 'recent-historical', feature: 'Recent historical cycles when no open cycle', mark: 'included', notes: 'Falls back to listCycles order.' },
  { id: 'timeline-id-status-time', feature: 'Compact timeline: cycle id, status, time', mark: 'included', notes: 'Unloaded cycles stay summary-only.' },
  { id: 'timeline-steps', feature: 'Step/checkpoint progression badges', mark: 'included', notes: 'Shown only after getCycle.steps is loaded for that cycle; unloaded items have no step chips.' },
  { id: 'report-read', feature: 'Report TLDR / availability', mark: 'included', notes: 'Full Markdown HTML stays in Viewer.' },
  { id: 'diary-read', feature: 'Diary items and TLDR', mark: 'included', notes: 'No raw diary HTML.' },
  { id: 'verify-status', feature: 'Verify status and semantic conclusion', mark: 'included', notes: 'available / semantic_status / counts.' },
  { id: 'blocker-summary', feature: 'Blocker and step-error summary', mark: 'included', notes: '' },
  { id: 'receipt-evidence', feature: 'Action receipt and evidence summary', mark: 'included', notes: 'Receipt count + attention count.' },
  { id: 'conversation-nav', feature: 'Conversation-to-cycle navigation helper', mark: 'included', notes: 'openEvolutionCycle / selectedCycleId.' },
  { id: 'realtime-refresh', feature: 'Realtime refresh via evolution.updated', mark: 'included', notes: 'Subject-scoped; deduped by cycle_id.' },
  { id: 'safe-states', feature: 'Empty / missing / malformed safe states', mark: 'included', notes: '' },
  { id: 'theme-keyboard', feature: 'Light/dark readable + keyboard sections', mark: 'included', notes: 'Collapse/expand owned by #115.' },
  { id: 'ops-home', feature: 'Ops Home KPI dashboard', mark: 'legacy-only', notes: 'Standalone Viewer landing page.' },
  { id: 'channel-pipeline', feature: 'Channel pipeline animation', mark: 'legacy-only', notes: 'Out of 0.1.0 scope.' },
  { id: 'channel-feed', feature: 'Channel event feed / workers / presence', mark: 'legacy-only', notes: '' },
  { id: 'event-stream', feature: 'Raw evolution event stream', mark: 'legacy-only', notes: '' },
  { id: 'daemon-bar', feature: 'Daemon control bar in Viewer', mark: 'legacy-only', notes: 'Service slot is a separate feature.' },
  { id: 'offline-build', feature: 'Offline static Viewer build', mark: 'legacy-only', notes: 'Not a replacement.' },
  { id: 'full-report-html', feature: 'Full marked report/diary HTML', mark: 'legacy-only', notes: 'Inspector shows TLDR/summary only.' },
  { id: 'task-table', feature: 'Daemon task queue table', mark: 'legacy-only', notes: '' },
  { id: 'hash-deeplink', feature: 'Standalone #cycle- hash routing', mark: 'legacy-only', notes: 'App uses navigation helper instead.' },
  { id: 'timeline-filter', feature: 'Complex timeline filter/search', mark: 'deferred', notes: 'Not implied removed.' },
  { id: 'cross-subject', feature: 'Cross-Subject comparison', mark: 'deferred', notes: 'Not implied removed.' },
  { id: 'raw-observability', feature: 'Every raw observability/evidence field', mark: 'deferred', notes: 'Not implied removed.' },
  { id: 'editing', feature: 'Editing reports/receipts/evidence/goals/beliefs', mark: 'deferred', notes: 'Read-only Inspector.' },
  { id: 'full-parity', feature: 'Full Ops Home / Viewer parity', mark: 'deferred', notes: 'Legacy Viewer remains.' }
]

export function parityInventoryMarkdown(): string {
  const lines = [
    '| Feature | Mark | Notes |',
    '| --- | --- | --- |',
    ...EVOLUTION_PARITY_INVENTORY.map((item) => `| ${item.feature} | \`${item.mark}\` | ${item.notes} |`)
  ]
  return lines.join('\n')
}
