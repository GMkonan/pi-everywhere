# AGENTS.md — pi-everywhere

## Mission

pi-everywhere gives a phone/browser a structured second UI for the **exact Pi process already running in a TUI/tmux session**. It must not reopen the same session JSONL in another Pi process.

## Current architecture

```text
Pi TUI + extension(s) ── NDJSON over Unix socket ── daemon ── WebSocket/HTTP ── PWA
```

- `src/extension/`: global Pi extension. It subscribes to structured Pi events and injects remote prompts with `pi.sendUserMessage()`.
- `src/server/`: local bridge daemon. It owns the live-process registry, routes commands, serves the PWA, and authenticates browser WebSockets.
- `src/shared/`: protocol types, NDJSON framing, and default paths.
- `frontend/`: production Svelte + TypeScript PWA source, built by Vite into `web-dist/`.
- `web/`: legacy dependency-free PWA retained temporarily for rollback and reusable safe parser/controller code during migration.
- `test/`: Node tests run through `tsx`; Svelte component/reducer tests run through Vitest.

Read `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, and `docs/SECURITY.md` before changing transport, process identity, authentication, or session behavior.

## Non-negotiable invariants

1. A live process is addressed by `instanceId`, not `sessionId`. Two processes may have opened the same persisted session.
2. The daemon never opens a Pi session file for writing.
3. Extension sockets/timers start in `session_start` and stop in `session_shutdown`. Never retain a stale `ExtensionContext` after shutdown/replacement.
4. While Pi is busy, `pi.sendUserMessage()` must receive `deliverAs: "steer" | "followUp"`.
5. Network I/O must not block Pi event handlers. Missing daemon connectivity must not degrade the TUI.
6. The HTTP server binds to loopback by default. Non-loopback binding requires an explicit opt-in; Tailscale Serve is the recommended transport.
7. Browser control requires a token. Treat it as equivalent to shell credentials.
8. Never render remote/session content through `innerHTML`; use text nodes/textContent.
9. Cap and sanitize payloads. Extension/tool details can be cyclic, huge, or non-JSON values.
10. Do not run two Pi processes against the same JSONL to simulate attachment.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run test:web
npm run build:web
npm run build
npm run check
npm run dev:server
npm run setup
npm run status
npm run doctor
npm run pair
npm run devices
```

Manual integration:

```bash
npm run dev:server
pi -e ./src/extension/index.ts
```

Then open `http://127.0.0.1:8484` and use the token path printed by the server. To load the extension into an existing Pi TUI after a local package install, run `/reload`.

## Pi API references

The local Pi documentation used for this design is under the installed `pi-monorepo/docs/` tree:

- `extensions.md`: lifecycle, event hooks, `pi.sendUserMessage`, `ctx.abort`, `ctx.sessionManager`.
- `session-format.md`: session tree and `SessionManager` methods.
- `packages.md`: local package installation and manifest format.
- `rpc.md`: useful protocol precedent, but RPC mode cannot attach to an existing TUI process.

When changing Pi integration, verify behavior against the installed Pi version rather than assuming upstream APIs.

## Current limitations

- Only currently connected/live Pi processes are shown.
- The initial browser registry is metadata-only. History is fetched only for the selected `instanceId`, cached in memory for up to three visited sessions, and limited to the latest 200 active-branch entries and a 1.5 MiB encoded budget; the UI reports omitted older entries.
- Paired browsers authenticate with per-device credentials in the first WebSocket message; the master-token query parameter remains as a temporary legacy fallback.
- Extension UI dialogs from other extensions still appear in the terminal, not the browser.
- No image upload, model picker, thinking-level picker, tree navigation, file browser, or terminal.
- In-progress transient state is not perfectly replayed after disconnection; a fresh snapshot recovers finalized entries.
- Linux setup can install a systemd user service; LaunchAgent and Home Manager support do not exist yet.
- Pi extensions do not expose every SDK/RPC event; only register event names present in the installed `ExtensionAPI` typings.

## Before finishing a change

Run `npm run check`. For transport/UI changes, manually test with at least two Pi TUI processes and verify commands route only to the selected `instanceId`. Update the relevant docs and this file when architecture, invariants, setup, or limitations change.
