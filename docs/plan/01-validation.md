# Phase 1 — Validate the current MVP

## Goal

Confirm that the existing architecture is reliable before expanding the product or migrating the UI.

## Planned work

- [x] Manually test two simultaneous Pi TUI/tmux processes and verify commands reach only the selected `instanceId`.
- [x] Confirm session lifecycle commands reconnect cleanly:
  - [x] `/reload`
  - [x] `/new`
  - [x] `/resume`
  - [x] `/fork`
  - [x] `/clone`
- [ ] Test browser suspension and reconnection through Tailscale Serve on physical devices:
  - [x] Android — Galaxy S23 PWA resumed successfully after the phone was locked.
  - [ ] iPhone.
- [x] Test large, cyclic, and custom tool-event serialization.
- [x] Cover routing and authentication with two fake agents sharing one `sessionId`, browser state recovery, and socket replacement.
- [x] Keep `instanceId` stable across extension reloads within the same Pi OS process.
- [x] Harden serialization against large values, invalid dates, cyclic data, throwing getters, and hostile proxies.

## Reliability findings to retain

These are recorded here so validation discoveries are not lost. They may be implemented in this phase or moved deliberately when the active plan is revised.

- [x] Route extension command acknowledgements only to the browser that originated the command.
- [x] Evict processes whose socket remains open but whose heartbeat becomes stale.
- [x] Preserve the selected process if the browser reconnects before extensions reconnect after a daemon restart.
- [x] Bound or split the initial multi-agent browser state message.
- [x] Add direct tests for snapshot entry-count and encoded-byte budgets.

## Completion signal

The current session lifecycle and reconnect behavior are understood, documented, and reliable enough that a frontend migration will not hide transport bugs.

## Validation log

### 2026-09-25 — Pi 0.85.1 live-process smoke test

- Started the daemon and two real Pi TUIs in separate detached tmux sessions.
- Observed two distinct process IDs and `instanceId` values in the authenticated browser state.
- Sent a `snapshot` command to one selected `instanceId`; only that extension returned the snapshot and successful command result.
- Ran `/reload` in the selected TUI and confirmed that its OS process and `instanceId` remained unchanged after reconnection.
- Ran `/new` and confirmed that the session ID changed while the OS process and `instanceId` remained unchanged.
- Exercised `/resume`, `/clone`, and `/fork` against isolated seeded sessions; every transition changed to the expected session while preserving the Pi PID and `instanceId`.
- Sent no model prompts during these smoke tests.
- Added direct snapshot-budget tests and a Unix-socket `BridgeClient` test carrying a large, cyclic custom-tool payload with invalid and throwing properties.

### 2026-09-25 — Android physical-device smoke test

- Opened the installed PWA on a Galaxy S23 through Tailscale Serve.
- Sent a prompt successfully from the phone, locked the device, and later reopened the PWA.
- The connection, selected session, and conversation appeared to recover correctly after suspension.
- Browser/install source still needs to be recorded; iPhone validation remains pending.

## Notes

Record discoveries here as testing progresses. Do not simulate attachment by opening the same session JSONL in a second Pi process.
