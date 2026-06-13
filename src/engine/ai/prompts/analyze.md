{{AGENT_CONTEXT_DOCS}}
# Strategic Analysis Task

## Background
You are the strategic advisor for an autonomous evolution loop. Perform a deep analysis based on the goals and data below.

{{GOALS_SECTION}}
## Current Data

### Platform Performance
```json
{{PLATFORM_DATA}}
```

### Execution Log Statistics
```json
{{EXECUTION_DATA}}
```

### Content State
```json
{{CONTENT_DATA}}
```

### Pending Feature Requests
```json
{{FEATURE_REQUESTS}}
```
{{CONTEXT_SECTION}}{{INTEL_SECTION}}

## Analysis Tasks

Please perform deep analysis covering:

### 1. Pattern Recognition
- What hidden patterns and trends are in the data?
- Which factors correlate strongly with success?
- Are there temporal regularities (e.g. day-of-week effects)?

### 2. Root Cause Analysis
- Why did certain artifacts perform well/poorly? (Don't stop at the surface.)
- What is the root cause of execution failures?
- What deeper reasons drive low engagement?

### 3. Opportunity Discovery
- What overlooked improvement opportunities exist?
- What are competitors doing that we can learn from?
- What innovative strategies are worth trying?

### 4. Strategic Recommendations
- What should be done short-term (this week)?
- What should be the focus mid-term (this month)?
- What is the long-term direction (3 months)?

### 5. Feature Request Review
- Evaluate feasibility and value of each pending request
- If no pending requests, analyze whether capability gaps exist
- Identify problems solvable by new features
- Assign priority and expected impact

### 6. Goal Assessment
For each active goal, give a qualitative judgement:
- Status (cross-check with good_signal / bad_signal)
- Recent trend (improving / stable / declining)
- Notable signals
- Whether to suggest re-focusing

## Output Format

Respond strictly in JSON (no extra text outside the JSON):

```json
{
    "pattern_recognition": {
        "key_patterns": ["..."],
        "success_factors": ["..."],
        "temporal_insights": ["..."]
    },
    "root_cause_analysis": {
        "high_performers_why": "...",
        "low_performers_why": "...",
        "failures_why": "..."
    },
    "opportunities": [
        {"opportunity": "...", "potential_impact": "high/medium/low", "effort": "high/medium/low"}
    ],
    "strategic_recommendations": {
        "short_term": ["..."],
        "medium_term": ["..."],
        "long_term": ["..."]
    },
    "feature_request_review": {
        "reviewed_requests": [
            {"request_id": "...", "verdict": "approve/defer/reject", "reason": "..."}
        ],
        "capability_gaps": ["missing capability description"],
        "suggested_features": ["proposed new feature"]
    },
    "goal_assessment": {
        "<goal_id>": {
            "status": "qualitative status",
            "trend": "improving/stable/declining",
            "signals": ["notable signals"],
            "suggestion": "optional"
        }
    },
    "confidence_score": 0.8
}
```

Begin analysis.
