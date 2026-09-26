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
- [ ] Represent connection, process selection, history, streaming, and composer state explicitly.
- [x] Migrate the session list with behavior parity.
- [ ] Migrate the conversation view with behavior parity.
- [ ] Migrate safe Markdown and tool rendering without introducing raw HTML rendering.
- [ ] Migrate PWA installation, reconnection, and push-notification behavior.
- [ ] Add component and mobile-browser regression tests for critical flows.
- [ ] Remove the old vanilla modules after parity is verified.

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
- The production legacy build remains unchanged until mobile parity testing permits cutover.

## Completion signal

The Svelte UI supports every current MVP flow on physical mobile devices, and the legacy frontend can be removed without protocol changes.
