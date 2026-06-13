{{AGENT_CONTEXT_DOCS}}
# Decision Task

## Background
You are the decision system. Based on the goals and analysis below, decide what actions to take.

{{GOALS_SECTION}}
## Analysis Result
```json
{{ANALYSIS_RESULT}}
```

## Resource Constraints
{{CONSTRAINTS_TEXT}}
{{GUIDANCE_SECTION}}{{ISSUES_SECTION}}
## Decision Requirements

1. **Goal alignment** — every action must declare which goal it serves (in `serves_goal`)
2. **Expected impact vs implementation cost** — prioritize high ROI
3. **Risk vs benefit** — assess each action's risk
4. **Short-term vs long-term** — balance immediate effects against long-term value
5. **Trade-offs** — when goals tension with each other, state the trade-off explicitly
6. **Resource bounds** — act within budget and capability

## Available Action Types

Your action proposals will be published as GitHub Issues (or local drafts) and consumed by the execution pipeline. The system supports:

{{ACTION_REGISTRY}}

You may also propose action types not in the list. For non-standard actions, describe execution steps in `params.execution_plan`.

## Output Format

Respond strictly in JSON:

```json
{
    "decision": "execute",
    "rationale": "Decision logic, including trade-offs",
    "actions": [
        {
            "type": "action_type_name",
            "description": "action description",
            "serves_goal": "natural-language description of which goal direction this serves",
            "priority": "high/medium/low",
            "update_issue": null,
            "params": {},
            "expected_impact": "expected effect",
            "risk": "risk description"
        }
    ],
    "deferred": [
        {
            "action": "deferred action",
            "reason": "why deferred",
            "revisit_after": "suggested re-evaluation timing"
        }
    ],
    "risk_mitigation": ["mitigation 1", "..."],
    "goal_suggestions": [
        {
            "suggestion": "optional goal-tree adjustment",
            "reason": "why"
        }
    ]
}
```

Notes:
- `update_issue` is an optional integer; only fill when this action is essentially the same as a pending Issue (use that issue's number); otherwise null.
- `serves_goal` may be free-text natural language; it doesn't have to match a goal id strictly.
- `goal_suggestions` is optional; only include if you think the goal tree itself needs adjustment.

Decide now.
