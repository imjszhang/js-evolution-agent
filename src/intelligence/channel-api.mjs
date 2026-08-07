// Contract-level facade: the ONLY intelligence entry points the channel layer
// may use. Changes to this surface require kernel-owner review (see
// src/contracts/OWNERSHIP.md). Channel code must not import other
// src/intelligence internals directly.
export { createIntelligenceStore } from './store.mjs';
export {
  readPendingOperatorBriefs,
  summarizeOperatorBriefsForContext,
  writePendingOperatorBrief,
} from './operator-briefs.mjs';
export { writePendingOperatorFact } from './operator-facts.mjs';
export { partitionBeliefs, summarizeBeliefForPrompt } from './beliefs.mjs';
export { redactSecrets } from './redaction.mjs';
