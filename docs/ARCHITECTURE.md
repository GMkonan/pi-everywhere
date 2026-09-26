# Architecture

## Goal

A browser should control the same in-memory Pi agent that is visible in a terminal. The terminal remains fully usable, tmux keeps the process alive, and no second process writes to the same session file.

## Components

### Pi extension

`src/extension/index.ts` is loaded into every participating Pi process.

On `session_start` it:

1. captures the current `ExtensionContext`;
2. connects to the daemon's Unix socket;
3. sends a `hello` containing process/session metadata and an active-branch snapshot;
4. forwards supported structured message, tool, turn, agent, and completed-compaction events;
5. accepts prompt, abort, and snapshot commands.

On `session_shutdown` it closes its socket, cancels reconnect/heartbeat timers, and drops the context. Session replacement and `/reload` therefore cannot leave callbacks using a stale session runtime.

If the daemon is absent, the extension reconnects with exponential backoff capped at two seconds, keeping daemon restarts responsive without busy-looping inside Pi. Events are not buffered while disconnected; the next snapshot recovers finalized history.

### Local daemon

`src/server/index.ts` owns two transports:

- a user-only Unix socket for Pi extensions;
- loopback HTTP/WebSocket for browsers.

The registry is keyed by a random per-process `instanceId`. A `sessionId` identifies persisted conversation state, not a unique live process, so it is not safe for command routing.

The daemon does not create Pi agents and does not mutate session JSONL files. It also owns short-lived in-memory pairing offers and the private store of hashed, revocable device credentials. On Linux, `pi-everywhere setup` installs it as a restart-on-failure systemd user service with a private umask; foreground development remains available separately.

### PWA

The production mobile UI is built from Svelte + TypeScript + Vite sources under `frontend/` into ignored `web-dist/`; Linux setup pins that directory through `PI_EVERYWHERE_WEB_ROOT`. The previous dependency-free `web/` build remains available through `setup --legacy-web` as a migration rollback until parity is complete. On connection the UI receives only a bounded metadata index of live processes, including durable activity timestamps but no transcript entries. Selecting a process creates a browser-local history watch and fetches that process's bounded snapshot on demand. Only the selected watch receives later full snapshot replacements; all capable browsers continue to receive small metadata upserts and incremental events. Snapshot/event reconciliation uses a daemon connection generation plus the extension event sequence so replacement runtimes cannot replay stale transient events into a new session. Clients that do not advertise `lazy-history-v1` temporarily retain eager state/upserts for a safe installed-PWA rollout. The browser keeps at most three visited histories in memory and never persists session content through the service worker. Its full-screen navigation groups live processes by conversation activity date; heartbeat timestamps are used only for liveness. Only connected processes are listed—the daemon does not enumerate offline session files.

Assistant history and live events are reduced into typed Svelte transcript items: thinking and tool calls use subdued activity rows, successful tool results do not dump their full output, and the final user-facing answer is visually separated and borderless. Streaming blocks are temporary and reconciled against the authoritative `message_end` payload. A local working indicator is driven by `agent_start`/`agent_settled`; its rotating phrases are decorative and do not claim to describe actual tool activity. Conversation Markdown continues to use the allowlisted parser and DOM structure built with `createElement`, text nodes, and `textContent`; remote/session content is never assigned through `innerHTML`. Links are protocol-restricted and Markdown images are not loaded automatically.

### Optional Web Push

An authenticated browser can register a Web Push subscription through same-origin HTTP endpoints. The daemon associates it with the paired device, stores the subscription and generated VAPID keys in a private state file, then sends a generic notification only when a known working instance emits `agent_settled`:

```text
agent_settled -> daemon -> browser push provider -> PWA service worker
```

Push delivery is fire-and-forget and never participates in command routing or blocks extension event handling. The service worker suppresses the system notification while a pi-everywhere window is visible. Notification clicks target the exact live `instanceId`; if it is no longer live, the normal session index remains open.

## Data flow

### Prompt from phone

```text
PWA command
  -> authenticated browser WebSocket
  -> daemon looks up instanceId
  -> NDJSON command over the selected extension socket
  -> extension calls pi.sendUserMessage()
  -> the same Pi AgentSession runs
  -> both TUI and extension observe normal Pi events
```

If the agent is busy, the UI chooses `followUp` (safe default) or `steer`. If idle, the extension sends the message immediately.

### Prompt from terminal

A prompt typed in the TUI follows Pi's normal path. The extension observes the resulting message/agent/tool events and forwards them to the browser. No terminal screen parsing is involved.

## Process and session lifecycle

- New TUI process: extension auto-loads and connects.
- Existing process after installation: `/reload` loads the extension.
- `/new`, `/resume`, `/fork`, `/clone`, or `/reload`: Pi shuts down the old extension runtime and starts a new one for the replacement session.
- Daemon restart: extensions reconnect and send fresh snapshots.
- Browser restart/background suspension: browser reconnects and receives daemon state.
- tmux detach: irrelevant; the Pi process and extension continue running.

## Default paths

- Unix socket: `$XDG_RUNTIME_DIR/pi-everywhere/bridge.sock`, falling back to `~/.pi/agent/pi-everywhere/bridge.sock`.
- Browser master token: `$XDG_CONFIG_HOME/pi-everywhere/token`, falling back to `~/.config/pi-everywhere/token`.
- Paired devices: `$XDG_CONFIG_HOME/pi-everywhere/devices.json`.
- HTTP: `127.0.0.1:8484`.

All paths and the HTTP host/port are configurable through environment variables documented in `docs/SECURITY.md`.
