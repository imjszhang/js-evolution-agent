import { CHANNEL_TASK_TYPES } from './types.mjs';

export const CHANNEL_ROLES = Object.freeze(['notify', 'control', 'presence', 'speech', 'classifier', 'custom', 'all']);

export const DEFAULT_CHANNEL_ROLES = Object.freeze(['notify', 'control', 'presence', 'speech', 'classifier']);

const ROLE_TASK_TYPES = Object.freeze({
  notify: ['channel_notify', 'channel_retry'],
  control: ['channel_control_action'],
  presence: ['channel_presence'],
  speech: ['channel_speech_generation'],
  classifier: ['channel_classifier'],
  custom: null,
  all: null,
});

export function taskTypesForChannelRole(role) {
  const key = String(role ?? '').trim().toLowerCase();
  if (!CHANNEL_ROLES.includes(key)) {
    throw new Error(`Unknown channel role: ${role}. Expected one of: ${CHANNEL_ROLES.join(', ')}`);
  }
  return ROLE_TASK_TYPES[key] ?? null;
}

export function parseChannelRolesInput(flags = {}) {
  const explicitTypes = flags['channel-task-types'] && flags['channel-task-types'] !== true
    ? String(flags['channel-task-types']).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  if (explicitTypes?.length) {
    for (const t of explicitTypes) {
      if (!CHANNEL_TASK_TYPES.includes(t)) {
        throw new Error(`Unsupported channel task type in --channel-task-types: ${t}`);
      }
    }
    return { mode: 'task_types', roles: ['custom'], taskTypes: explicitTypes };
  }

  const rolesRaw = flags['channel-roles'] && flags['channel-roles'] !== true
    ? String(flags['channel-roles'])
    : (flags['channel-role'] && flags['channel-role'] !== true ? String(flags['channel-role']) : null);

  if (!rolesRaw) {
    return { mode: 'roles', roles: [...DEFAULT_CHANNEL_ROLES], taskTypes: null };
  }

  const roles = rolesRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!roles.length) {
    return { mode: 'roles', roles: [...DEFAULT_CHANNEL_ROLES], taskTypes: null };
  }
  for (const role of roles) {
    if (!CHANNEL_ROLES.includes(role)) {
      throw new Error(`Unknown channel role: ${role}`);
    }
  }
  if (roles.includes('all')) {
    return { mode: 'roles', roles: ['all'], taskTypes: null };
  }
  return { mode: 'roles', roles, taskTypes: null };
}

export function resolveChannelRoles(flags = {}) {
  return parseChannelRolesInput(flags).roles;
}

export function resolveChannelWorkerTaskTypes(flags = {}, role = null) {
  const parsed = parseChannelRolesInput(flags);
  if (parsed.taskTypes) return parsed.taskTypes;
  if (role === 'custom') return [];
  if (role) return taskTypesForChannelRole(role);
  return null;
}
