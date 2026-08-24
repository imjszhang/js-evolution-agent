/**
 * Grounded operator affordances for presence LLM (no invented CLI).
 */
export function resolvePresenceAffordances(root, subject) {
  const subj = subject;
  return {
    capabilities: [
      'Acknowledge inbound messages already ingested (brief, fact, observation).',
      'Queue outbound messages via channel outbox (transport adapter sends).',
      'Trigger a read-only intelligence agent run (start_agent_async) for questions that need investigation; its deliverable is delivered automatically.',
      'Rich agent-run deliverables (tables, code, long reports) are delivered as Feishu documents automatically; short answers go as text. The channel supports both text and document delivery.',
      'Write operator intent briefs for the next intel cycle (not approval_granted).',
      'Record observations into unified intelligence.',
      'Stay silent when nothing new requires expression.',
    ],
    boundaries: [
      'Cannot grant approval_granted or modify pending_decisions.json.',
      'Presence planner cannot execute control actions directly; only the channel control executor may run registered control_request actions.',
      'Cannot claim remote publish or code execution already completed.',
      'Do NOT claim you lack permission to create or send Feishu documents — document delivery is supported and automatic for rich deliverables. If a document was expected but not received, consult channel.recent_deliverables.delivery_status / delivery_error for the real reason instead of guessing.',
      'CLI commands in replies must come from operator_commands only.',
    ],
    operator_commands: [
      {
        id: 'daemon_evolution_state_active',
        purpose: 'Resume automatic evidence-driven reactions.',
        cmd: `npm run jea -- daemon evolution-state set active --subject ${subj}`,
      },
      {
        id: 'daemon_evolution_state_paused',
        purpose: 'Pause new Cognitive/Exec reactions; verify/settlement/memory may still finish.',
        cmd: `npm run jea -- daemon evolution-state set paused --subject ${subj}`,
      },
      {
        id: 'daemon_evolution_state_show',
        purpose: 'Show current evolution state (active or paused).',
        cmd: `npm run jea -- daemon evolution-state show --subject ${subj}`,
      },
      {
        id: 'daemon_reaction_request',
        purpose: 'Request one cognitive reaction / immediate check.',
        cmd: `npm run jea -- daemon reaction request --subject ${subj}`,
      },
      {
        id: 'daemon_evolution_mode_continuous',
        purpose: 'Deprecated. Writes evolution.mode only; does not change scheduling.',
        cmd: `npm run jea -- daemon evolution-mode set continuous --subject ${subj}`,
      },
      {
        id: 'daemon_evolution_mode_on_demand',
        purpose: 'Deprecated. Writes evolution.mode only; does not change scheduling.',
        cmd: `npm run jea -- daemon evolution-mode set on_demand --subject ${subj}`,
      },
      {
        id: 'daemon_evolution_mode_show',
        purpose: 'Deprecated. Show legacy evolution.mode; prefer evolution-state.',
        cmd: `npm run jea -- daemon evolution-mode show --subject ${subj}`,
      },
      {
        id: 'daemon_cycle_request',
        purpose: 'Compat alias of reaction request.',
        cmd: `npm run jea -- daemon cycle request --subject ${subj}`,
      },
      {
        id: 'intel_brief_put',
        purpose: 'Submit operator intent brief for next intel cycle (approval, verification, etc.).',
        cmd: `npm run jea -- intel brief put --subject ${subj} --file <path-to-brief.json>`,
      },
      {
        id: 'channel_status',
        purpose: 'Inspect channel worker, queues, and Feishu listener reload state.',
        cmd: `npm run jea -- channel status --subject ${subj} --json`,
      },
      {
        id: 'channel_presence_run',
        purpose: 'Run one presence loop iteration (ingest + plan + execute).',
        cmd: `npm run jea -- channel presence run --subject ${subj}`,
      },
      {
        id: 'daemon_status',
        purpose: 'Inspect cycle daemon worker health and open cycles.',
        cmd: `npm run jea -- daemon status --subject ${subj} --json`,
      },
    ],
  };
}
