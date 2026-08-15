# JEA Desktop

JEA Desktop is an Electron operations client for local JEA subjects. It keeps
runtime files authoritative: the renderer never receives Node.js access,
credentials, child-process handles, or direct file-write capabilities.

## Run

From the repository root:

```bash
npm run desktop:dev
npm run desktop:build
npm run desktop:test
```

The client loads the repository from `JEA_PROJECT_ROOT` when set, otherwise it
walks up from the bundled main process and the current working directory until
it finds `oada.config.mjs` and `src/cli/jea.mjs`.

Main-process IPC responses and renderer events are JSON-cloned before they
cross the sandbox. That keeps Electron from hanging on a non-cloneable
`ops.refresh` payload and keeps secrets / handles out of the renderer. A
headless check is available after `npm run desktop:build`:

```bash
JEA_DESKTOP_SMOKE=/tmp/jea-desktop-smoke.json npx electron apps/desktop
```

## Operations and controlled writes

The Operations page reads the canonical daemon and observability projections.
The Todo page uses existing domain APIs to:

- submit one-cycle operator briefs and facts;
- resolve operator questions;
- request a cycle and cognitive wake;
- replace active goals after validation and explicit confirmation.

These actions never write `pending_decisions.json` or `standing_memory.json`
directly. Destructive data reset, task cancellation, and automatic goal
assessment are not exposed.

## Daemon ownership

Daemon status distinguishes:

- **attached**: a worker started outside this client; closing the client leaves
  it running and the Stop control is unavailable;
- **managed**: a non-detached child started by this client; it can be stopped
  from the UI and is cleaned up when the client exits;
- **stale/zombie**: worker metadata whose heartbeat or PID is unhealthy.

The in-memory child handle, owner token, and PID must all match before the
client can stop a process. Diagnostic metadata never grants ownership after an
application restart. A single-instance lock prevents duplicate supervisors.

## ACP work sessions

The ACP page lists configured frameworks, opens a native execution-root picker,
and runs each session in an isolated main-process child. Text, thinking, plans,
tool lifecycle events, and permission requests are sent to the renderer as
sanitized event envelopes.

Permission behavior:

- the operator can select only options offered by the ACP agent;
- allow-once and session-wide allow are distinct when both are offered;
- unknown tools, remote access, read-only writes, and paths outside the
  execution roots are rejected by default;
- cancel, timeout, session close, and application exit resolve pending
  permissions and terminate the child with a bounded SIGTERM-to-SIGKILL
  fallback.

Credentials and execution-root `.env` values remain in the main process.
Desktop ACP sessions are separate from Channel desktop chat sessions.

The real Claude ACP smoke requires an available `claude-agent-acp` binary and
either local agent login or configured Anthropic credentials. Protocol-level
tests use `test/fixtures/fake-acp-agent.mjs` and do not need credentials.
