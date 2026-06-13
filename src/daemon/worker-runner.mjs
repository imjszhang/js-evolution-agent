/**
 * Daemon worker orchestration boundary.
 *
 * This compatibility module gives domain imports a stable home before the
 * legacy CLI implementation is fully decomposed.
 */
export {
  runChannelDomainWorker,
  runDaemonDomains,
  runDaemonWorker,
} from '../cli/commands/daemon.mjs';
