#!/usr/bin/env bash
# Run jea against the sandbox subject with M2 observation env.
# Does not pollute agentank-tank / project-root .env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export JEA_RULE_FEEDBACK_STREAK_UNIT=evidence
export JEA_RULE_FEEDBACK_STARVED_STRATEGY=wall_clock
export JEA_RULE_FEEDBACK_STARVED_WINDOW_HOURS=48
export JEA_RULE_FEEDBACK_STARVED_STREAK_EVIDENCE=12
export JEA_RULE_FEEDBACK_WINDOW_EVIDENCE=24
export JEA_GOAL_AUTO_APPLY=0

OBSERVE_FILE="$ROOT/runtime/subjects/js-evolution-agent/.env.observe"
if [[ -f "$OBSERVE_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$OBSERVE_FILE"
  set +a
fi

exec node --preserve-symlinks "$ROOT/src/cli/jea.mjs" "$@" --subject js-evolution-agent
