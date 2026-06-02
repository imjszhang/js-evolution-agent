import { join } from 'node:path';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';

export function channelDirForSubject(root, subject) {
  return join(runtimeForSubject(root, subject).dataRoot, 'channel');
}

export function channelWorkerStatePath(root, subject) {
  return join(channelDirForSubject(root, subject), 'worker-state.json');
}

export function channelTasksDir(root, subject) {
  return join(channelDirForSubject(root, subject), 'tasks');
}

export function channelEventsPath(root, subject) {
  return join(channelDirForSubject(root, subject), 'events.jsonl');
}

export function channelInboundDir(root, subject) {
  return join(channelDirForSubject(root, subject), 'inbound');
}

export function channelInboundPendingDir(root, subject) {
  return join(channelInboundDir(root, subject), 'pending');
}

export function channelInboundProcessedDir(root, subject) {
  return join(channelInboundDir(root, subject), 'processed');
}

export function channelInboundFailedDir(root, subject) {
  return join(channelInboundDir(root, subject), 'failed');
}

export function channelCursorPath(root, subject) {
  return join(channelInboundDir(root, subject), 'cursor.json');
}

export function channelDedupPath(root, subject) {
  return join(channelInboundDir(root, subject), 'dedup.json');
}

export function channelOutboxDir(root, subject) {
  return join(channelDirForSubject(root, subject), 'outbox');
}

export function channelOutboxPendingDir(root, subject) {
  return join(channelOutboxDir(root, subject), 'pending');
}

export function channelOutboxSentDir(root, subject) {
  return join(channelOutboxDir(root, subject), 'sent');
}

export function channelOutboxFailedDir(root, subject) {
  return join(channelOutboxDir(root, subject), 'failed');
}

export function channelCooldownPath(root, subject) {
  return join(channelDirForSubject(root, subject), 'cooldown.json');
}

export function channelReloadRequestPath(root, subject) {
  return join(channelDirForSubject(root, subject), 'reload-request.json');
}

export function channelReloadStatePath(root, subject) {
  return join(channelDirForSubject(root, subject), 'reload-state.json');
}

export function channelPresenceStatePath(root, subject) {
  return join(channelDirForSubject(root, subject), 'presence-state.json');
}
