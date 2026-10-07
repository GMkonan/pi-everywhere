# Phase 3 — Svelte frontend migration

## Goal

Replace the growing imperative JavaScript UI with a maintainable mobile-first component and state model while preserving behavior.

## Intended stack

- Svelte with TypeScript
- Vite
- Existing CSS or small scoped component styles
- Vitest and Testing Library
- Playwright mobile viewports
- PWA manifest and service worker support

SvelteKit is not required unless a concrete routing or build need appears. The daemon can continue serving a static Vite build.

## Boundaries

Keep the existing Node/TypeScript daemon, Pi extension, shared protocol, Unix socket, WebSocket transport, and security defaults. Do not combine the migration with a transport redesign.

## Planned work

- [x] Establish the Vite/Svelte build and integrate its output with the daemon behind an explicit web-root opt-in.
- [x] Represent connection, process selection, history, streaming, and composer state explicitly.
- [x] Migrate the session list with behavior parity.
- [x] Migrate the conversation transcript and live event rendering with behavior parity.
- [x] Migrate safe Markdown and tool rendering without introducing raw HTML rendering.
- [x] Migrate PWA installation, reconnection, and push-notification behavior.
- [x] Add component and controller regression tests for critical flows.
- [ ] Remove the standalone vanilla rollback build after an additional physical-device parity window.

## Implementation log

### 2026-09-26 — Compatibility build foundation

- Added an isolated Svelte 5 + TypeScript + Vite frontend build under `frontend/`, producing `web-dist/`.
- Reproduced the existing DOM shell as a static Svelte component and loads the legacy controller only after mount, preserving behavior while state migrates incrementally.
- Reuses the existing mobile-first CSS and includes a Vite-compatible service worker retaining Push and notification-click behavior.
- Generalized static serving for safe, MIME-restricted hashed assets with traversal protection.
- The legacy `web/` frontend remains the production default. `PI_EVERYWHERE_WEB_ROOT=/absolute/path/to/web-dist` enables explicit parity testing before cutover.

### 2026-09-26 — Session list component

- Added typed agent/session-list state and a narrow compatibility bridge from the existing WebSocket controller.
- Svelte now owns session grouping, activity ordering, selected state, working state, and tap routing in the compatibility build.
- Added Vitest, jsdom, and Testing Library component coverage for rendering, selection, synchronization, and action routing.
- Centralized shell icons and replaced the visible `π` session badge with a connected-process mark. The Svelte PWA icon follows the same connected-nodes direction and no longer uses the pi glyph.
- The production legacy build remained unchanged for the initial mobile parity test.

### 2026-09-26 — Persistent Svelte frontend and conversation transcript

- Linux setup now validates `web-dist/index.html` and persists the Svelte web root in the private systemd unit; `setup --legacy-web` provides an explicit rollback.
- Added a typed transcript reducer for snapshots, truncation notices, user/assistant messages, thinking, tools, compaction, branch summaries, errors, and system messages.
- Streaming thinking/text blocks are temporary, keyed by content index, and replaced by the authoritative finalized assistant message without duplicate separators.
- Svelte now owns transcript item and tool rendering. Markdown remains protected by the existing allowlisted DOM parser and is never inserted with `innerHTML`.
- Added reducer and component tests for ordering, tool transitions, streaming cleanup, hidden custom messages, aborts, hostile HTML text, safe links, and transcript semantics.
- The Svelte build is now the installed service default after the session-list mobile smoke test; the legacy frontend remains available only for rollback while migration continues.
- Physical Galaxy S23 use confirmed that the migrated conversation/history view appears to work correctly.

### 2026-09-26 — On-demand mobile history

- Replaced the eager all-session transcript transfer with a metadata-only live-process index carrying daemon-maintained activity timestamps.
- Selecting a session now creates a browser-specific history watch; full snapshot updates go only to browsers watching that exact `instanceId`.
- Added an accessible loading state, stale-response protection through request IDs, connection-generation/event-sequence reconciliation, and a three-session memory-only history cache.
- Snapshot and reconnect updates preserve lightweight list metadata while refreshing the selected conversation without broadcasting every transcript.
- Added a bounded serialized browser send queue and temporary capability negotiation so suspended pre-migration PWA windows continue receiving eager state until they reload.
- Added protocol, registry, frame-budget, component, and two-browser integration coverage for metadata-only state and private on-demand history routing.
- On the 10-process host, the authenticated initial transfer dropped from roughly 7.15 MiB across five frames to 11.3 KiB in one frame; local index arrival measured 12 ms.
- Selected history is now additionally paged: the newest 16 entries render first, older 16-entry pages load on demand, and prepends preserve the reading position. `paged-history-v1` capability negotiation keeps older lazy-history clients on full snapshots.
- Svelte now owns the composer, including multiline keyboard behavior, bounded in-memory image previews, model capability state, and text/image submission through the legacy WebSocket controller.

### 2026-10-01 — Native Svelte controller

- Replaced the dynamically imported `web/app.js` state machine with a typed controller under `frontend/src/lib/controller.ts`.
- The controller now owns credential exchange, WebSocket authentication, registry synchronization, lazy/paged history, event reconciliation, commands, reconnect/background recovery, settings, and Push state.
- Removed the global `window.__PI_EVERYWHERE_SVELTE__` compatibility bridge, moved the safe Markdown renderer into typed frontend code, and collapsed the production JavaScript output from two runtime chunks into one Svelte bundle.
- Added an end-to-end controller test with a fake WebSocket covering authentication, metadata state, selected history, transcript reduction, prompt commands, and acknowledgements.
- The dependency-free `web/` implementation remains isolated behind `setup --legacy-web`; the production Svelte bundle no longer imports it.

## Completion signal

The Svelte UI supports every current MVP flow on physical mobile devices, and the legacy frontend can be removed without protocol changes.
