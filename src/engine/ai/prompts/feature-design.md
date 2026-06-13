# Feature Design Task

## Your Role
You are an architect for the project below. Design a detailed implementation plan for a new feature request.

## Feature Request
- **Description**: {{DESCRIPTION}}
- **Priority**: {{PRIORITY}}
- **Source**: {{SOURCE}}

## Project Codebase Structure
```
{{CODEBASE_CONTEXT}}
```

## Design Constraints

1. **Architecture style**: follow the existing project conventions
2. **Minimal dependencies**: prefer Node.js built-ins and existing dependencies
3. **Safety first**: file modifications must support backup and rollback
4. **Clear integration**: state how the new code wires into existing entry points

## Design Tasks

Design the implementation, covering:

### 1. Module Plan
- Which new files to create? In which directories?
- Which existing files need modification?

### 2. Interface Design
- Class and function signatures
- Input/output data structures

### 3. Integration Plan
- How does it integrate with existing code?
- Does it need a new CLI command or service registration?

### 4. Verification Plan
- How to verify correctness?
- What tests are needed?

## Output Format

Respond strictly in JSON:

```json
{
    "module_name": "module name",
    "file_plan": [
        {"path": "src/xxx/yyy.mjs", "action": "create", "description": "responsibility"},
        {"path": "src/existing/file.mjs", "action": "modify", "description": "what to modify"}
    ],
    "interfaces": [
        {
            "name": "ClassName", "type": "class", "file": "src/xxx/yyy.mjs",
            "signature": "export class ClassName { method(arg) { } }",
            "description": "responsibility"
        }
    ],
    "integration_points": [
        {"file": "path", "description": "integration description"}
    ],
    "dependencies": [],
    "test_plan": "verification plan",
    "estimated_complexity": "low/medium/high",
    "implementation_notes": "implementation notes"
}
```

Begin design.
