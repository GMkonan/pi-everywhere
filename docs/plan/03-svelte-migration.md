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

- [ ] Establish the Vite/Svelte build and integrate its output with the daemon.
- [ ] Represent connection, process selection, history, streaming, and composer state explicitly.
- [ ] Migrate the session list and conversation view with behavior parity.
- [ ] Migrate safe Markdown and tool rendering without introducing raw HTML rendering.
- [ ] Migrate PWA installation, reconnection, and push-notification behavior.
- [ ] Add component and mobile-browser regression tests for critical flows.
- [ ] Remove the old vanilla modules after parity is verified.

## Completion signal

The Svelte UI supports every current MVP flow on physical mobile devices, and the legacy frontend can be removed without protocol changes.
