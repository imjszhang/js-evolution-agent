/**
 * Pure client-lifecycle planner. Does not start processes or invent a second
 * scheduler. The Desktop supervisor executes attach/start/stop ownership.
 *
 * Future: an optional "keep running after window close" hook is not required
 * for 0.2.0. Default shutdown still stops only Desktop-owned workers.
 */

export function subjectLifecycleInput(name, input = {}) {
  return {
    name,
    automation: input.automation === 'paused' ? 'paused' : 'automatic',
    background: input.background === true,
    desktopChannelEnabled: input.desktopChannelEnabled === true,
    ownedCycle: input.ownedCycle === true,
    ownedChannel: input.ownedChannel === true,
    cycleLive: input.cycleLive === true,
    channelLive: input.channelLive === true,
    previousSupervisorCycle: input.previousSupervisorCycle === true,
    previousSupervisorChannel: input.previousSupervisorChannel === true,
  };
}

function pushUnique(actions, action) {
  const key = `${action.subject}:${action.domain}:${action.action}:${action.reason ?? ''}`;
  if (actions.some((item) => `${item.subject}:${item.domain}:${item.action}:${item.reason ?? ''}` === key)) {
    return;
  }
  actions.push(action);
}

function planStopPrevious(previous, subjects, actions) {
  if (!previous) return;
  const info = subjects.get(previous);
  if (!info || info.background) return;
  if (info.ownedCycle) {
    pushUnique(actions, {
      subject: previous,
      domain: 'cycle',
      action: 'stop',
      reason: 'subject_switch',
    });
  }
  if (info.ownedChannel) {
    pushUnique(actions, {
      subject: previous,
      domain: 'channel',
      action: 'stop',
      reason: 'subject_switch',
    });
  }
}

function planSubject(info, actions) {
  if (!info) return;
  if (info.desktopChannelEnabled) {
    pushUnique(actions, {
      subject: info.name,
      domain: 'channel',
      action: info.channelLive ? 'attach' : 'ensure',
      reason: info.channelLive
        ? (info.previousSupervisorChannel ? 'previous_supervisor_owner' : 'already_running')
        : 'conversation_enabled',
    });
  }
  if (info.automation === 'paused') {
    if (info.ownedCycle) {
      pushUnique(actions, {
        subject: info.name,
        domain: 'cycle',
        action: 'stop',
        reason: 'paused',
      });
    } else {
      pushUnique(actions, {
        subject: info.name,
        domain: 'cycle',
        action: 'skip',
        reason: info.cycleLive ? 'external_or_paused' : 'paused',
      });
    }
    return;
  }
  pushUnique(actions, {
    subject: info.name,
    domain: 'cycle',
    action: info.cycleLive ? 'attach' : 'ensure',
    reason: info.cycleLive
      ? (info.previousSupervisorCycle ? 'previous_supervisor_owner' : 'already_running')
      : 'automatic',
  });
}

/**
 * @param {{
 *   activeSubject?: string | null,
 *   previousSubject?: string | null,
 *   reason?: string,
 *   subjects?: Array<{
 *     name: string,
 *     automation?: string,
 *     background?: boolean,
 *     desktopChannelEnabled?: boolean,
 *     ownedCycle?: boolean,
 *     ownedChannel?: boolean,
 *     cycleLive?: boolean,
 *     channelLive?: boolean,
 *     previousSupervisorCycle?: boolean,
 *     previousSupervisorChannel?: boolean,
 *   }>
 * }} [input]
 */
export function planClientLifecycle({
  activeSubject = null,
  previousSubject = null,
  reason = 'reconcile',
  subjects = [],
} = {}) {
  const map = new Map();
  for (const item of subjects) {
    if (!item?.name) continue;
    map.set(item.name, subjectLifecycleInput(item.name, item));
  }

  const actions = [];
  if (previousSubject && previousSubject !== activeSubject) {
    planStopPrevious(previousSubject, map, actions);
  }

  const targets = new Set();
  if (activeSubject) targets.add(activeSubject);
  if (reason === 'startup') {
    for (const info of map.values()) {
      if (info.background) targets.add(info.name);
    }
  }

  for (const name of targets) {
    planSubject(map.get(name), actions);
  }

  return {
    active_subject: activeSubject,
    previous_subject: previousSubject && previousSubject !== activeSubject ? previousSubject : null,
    reason,
    actions,
  };
}
