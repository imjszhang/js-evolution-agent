/**
 * Daemon step execution boundary.
 *
 * The implementation still delegates to the legacy CLI module while Phase 3
 * moves internals out of edge code in smaller pieces.
 */
export {
  channelWorkOnce,
  workOnce,
} from '../cli/commands/daemon.mjs';
