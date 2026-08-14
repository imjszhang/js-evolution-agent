/**
 * Neutral investigation loop extracted from agent_loop (S9).
 * Keep this re-export until remaining callers migrate off src/evolution/agent-loop/.
 */
export { runInvestigationLoop, runAgentLoop } from '../agent-loop/loop-runner.mjs';
