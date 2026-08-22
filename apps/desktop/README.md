# JEA Desktop

JEA Desktop is an Electron host for the shared `@jea/app` workspace. The
renderer never receives Node.js access, credentials, child-process handles, or
direct file-write capabilities. Electron and localhost Web host the same
three-column workspace: Subject/session navigation, governed Conversation, and
Evolution Inspector, with Settings as an overlay.

## Run

From the repository root:

```bash
npm run desktop:dev
npm run desktop:build
npm run desktop:test
npm run desktop:smoke
```

The client loads the repository from `JEA_PROJECT_ROOT` when set, otherwise it
walks up from the bundled main process and the current working directory until
it finds `oada.config.mjs` and `src/cli/jea.mjs`.

Subject state is resolved independently from `JEA_HOME` (default `~/.jea` or
`%USERPROFILE%\.jea`). The source root supplies code and build artifacts;
registry, governance files, Channel sessions, queues, checkpoints, backups,
and managed-daemon logs live under JEA Home. Desktop passes both roots to every
managed child.

The current build is a repository-local client, not a relocatable installer:
`apps/desktop/out` keeps imports to the checkout's JEA domain modules and must
run with the source tree and dependencies present.

Main-process IPC responses and renderer events are JSON-cloned before they
cross the sandbox. That keeps Electron from hanging on a non-cloneable
`ops.refresh` payload and keeps secrets / handles out of the renderer. A
headless check is available after `npm run desktop:build`:

```bash
npm run desktop:smoke
```

## Operator projection and controlled writes

`projectOperatorSurface` is the renderer boundary for mixed operational state.
It keeps Conversation readiness, Evolution summary, observability attention,
pending evidence, pending daemon tasks, and host-filtered remediation actions
as separate fields. Counts come only from canonical projections; legacy
fixture-only aggregate backlog fields are ignored.

Conversation cards and Settings remediation actions use existing domain APIs to:

- submit one-shot operator briefs and fact seeds;
- resolve operator questions;
- request a cognitive wake;
- replace active goals after validation and explicit confirmation.

These actions never write `pending_decisions.json` or `standing_memory.json`
directly. Destructive data reset, task cancellation, and automatic goal
assessment are not exposed.

Operator projections update from subject runtime files without a
manual refresh. The main process coalesces file bursts, tails JSONL from byte
offsets, and periodically reconciles missed filesystem notifications. Watchers
are scoped to the selected subject and released when the subject or window
changes.

## Governed Conversation and Channel delivery

The Conversation surface is a UI over the existing `channels.desktop` adapter. Sending
a message calls the controlled inbound API; it does not write session JSONL
from the renderer. Replies appear only after the classifier, presence, speech,
redacted outbox, and notify pipeline appends the assistant record. Speech
failure, timeout, rate limiting, or cooldown does not advance the handled
cursor, so eligible input is retried without silently disappearing.

The inbound feed also shows processed Feishu messages and classifier
understanding. Feishu chats remain external transport records and are not
presented as local desktop sessions. A draft send reuses the same message id
only when subject, session, and content are unchanged. Editing the draft or
switching subject/session allocates a new id; a network or IPC retry of the
same attempt keeps the previous id. The renderer keeps at most the latest
400 session records; older history remains on disk and can be re-read.

Start or attach a Channel daemon for the selected subject to receive replies:

```bash
npm run jea -- daemon start --subject NAME --domain channel
```

System alerts for new operator questions and warning/critical attention
signals can be disabled in the sidebar. Opening an alert selects the relevant
workspace context; it never resolves a question or performs another write.

## Daemon ownership

Daemon status distinguishes:

- **attached**: a worker started outside this client; closing the client leaves
  it running and the Stop control is unavailable;
- **managed**: a tracked child started by this client (a dedicated process
  group on POSIX); it can be stopped from the UI and is cleaned up when the
  client exits;
- **stale/zombie**: worker metadata whose heartbeat or PID is unhealthy.

The in-memory child handle, owner token, and PID must all match before the
client can stop a process. Diagnostic metadata never grants ownership after an
application restart. A stale worker may still be alive and therefore blocks a
replacement start; only absent or confirmed-dead state is startable. A
single-instance lock prevents duplicate supervisors.

## Agent work sessions

Agent work is launched from governed conversation/action surfaces. Configured
ACP frameworks run each session in an isolated main-process child after a
native execution-root selection. Text, thinking, plans, tool lifecycle events,
and permission requests are sent to the renderer as sanitized event envelopes.

Permission behavior:

- the operator can select only options offered by the ACP agent;
- allow-once and session-wide allow are distinct when both are offered;
- unknown tools, remote access, read-only writes, and paths outside the
  execution roots are rejected by default;
- cancel and timeout resolve the active turn and its pending permissions;
- session close and application exit terminate the child with a bounded
  SIGTERM-to-SIGKILL fallback.

On POSIX the ACP child is placed in its own process group so shutdown can
signal the whole tree. On Windows the framework registry resolves local
`.cmd` shims and uses process-tree cleanup. ACP timelines retain a bounded
event window and cap merged assistant text so long sessions cannot grow
renderer memory without limit.

Credentials and execution-root `.env` values remain in the main process.
Desktop ACP sessions are separate from Channel desktop chat sessions.

## Evolution Inspector and 0.2.0 compatibility

The Inspector projects the causal chain rather than inferring progress from a
legacy cycle page: evidence batch/reaction, belief-bound decision, execution,
expected-output comparison, settlement, and Memory Reactor freshness. Missing
optional causal/comparison fields in 0.1.0 fixtures render as legacy/unknown;
the client never fabricates links.

Electron and Web use the same operator projection. Runtime maintenance may
archive terminal sidecar records, so clients consume canonical counts and
append-only authority events instead of assuming every terminal task remains
in a hot JSON store.

Hidden-window smoke (`npm run desktop:smoke`) creates separate one-off source,
JEA Home, guard-home, and ACP execution fixtures, then sends Channel traffic
only to the fixture subject. Electron still loads the real repository build. ACP
`startSession`, `prompt`, and `closeSession` must each succeed; `closeSession`
always runs in `finally`. The fixture and ACP execution roots are removed on
success or failure; neither the real source checkout nor a default user
`~/.jea` is written.

The real Claude ACP smoke requires an available `claude-agent-acp` binary and
either local agent login or configured Anthropic credentials. Protocol-level
tests use `test/fixtures/fake-acp-agent.mjs` and do not need credentials.
