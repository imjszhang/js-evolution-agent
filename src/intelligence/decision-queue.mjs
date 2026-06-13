/**
 * @deprecated Use DecisionQueue from ../engine/index.mjs directly.
 */
import {
  DecisionQueue,
  decisionFingerprint,
} from '../engine/index.mjs';
import {
  handleContractValidation,
  validateDecision,
} from '../contracts/index.mjs';

export { decisionFingerprint };

export function createHostDecisionQueue({ dataDir, logFn } = {}) {
  return new DecisionQueue({
    dataDir,
    logFn,
    onDecisionAdded: (decision) => {
      handleContractValidation('decision', validateDecision(decision), {
        logger: { warn: (msg) => logFn?.(`[contract] ${msg}`) },
      });
    },
  });
}

/** @deprecated alias for DecisionQueue */
export class LocalDecisionQueue extends DecisionQueue {
  constructor(opts = {}) {
    const { dataDir, logFn } = opts;
    super({
      dataDir,
      logFn,
      onDecisionAdded: (decision) => {
        handleContractValidation('decision', validateDecision(decision), {
          logger: { warn: (msg) => logFn?.(`[contract] ${msg}`) },
        });
      },
    });
  }
}

export { DecisionQueue };
