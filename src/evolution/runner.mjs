/**
 * Evolution process runner facade.
 *
 * The process-spawn implementation remains in the CLI command module until the
 * rest of Phase 3 moves command routing away from execution concerns.
 */
export {
  runSingleCycle,
  runSingleStep,
} from '../cli/commands/evolve.mjs';
