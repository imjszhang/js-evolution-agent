/**
 * Cognition domain facade for goal assessment/calibration.
 *
 * Internals still delegate to the legacy CLI command module while Phase 3
 * migrates implementation details out of edge code.
 */
export {
  assessActiveGoals,
  autoCalibrateGoals,
} from '../../cli/commands/goals.mjs';
