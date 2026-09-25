# Roadmap

## MVP implemented

- [x] Pi extension attached to existing TUI processes.
- [x] Unix-socket registration and automatic reconnect.
- [x] Live-process dashboard.
- [x] Active-branch history snapshot.
- [x] Streaming assistant text and basic tool activity.
- [x] Prompt, steer/follow-up, and abort commands.
- [x] Loopback-only HTTP server and browser token.
- [x] Mobile-first installable PWA.
- [x] Architecture, protocol, security, and agent-context documentation.

## Planned direction

The product direction is a mobile-first Svelte PWA with very simple setup. The existing Pi extension, daemon, protocol, and live-process architecture remain in place. A native wrapper is not planned now; Capacitor will be reconsidered only if physical-device testing exposes concrete PWA limitations.

The plan is intentionally lightweight and split into phase documents:

1. [`plan/01-validation.md`](plan/01-validation.md) — validate the current MVP and lifecycle behavior.
2. [`plan/02-onboarding.md`](plan/02-onboarding.md) — one-command setup, service management, Tailscale guidance, and QR pairing.
3. [`plan/03-svelte-migration.md`](plan/03-svelte-migration.md) — migrate the web UI to Svelte, TypeScript, and Vite without changing the transport architecture.
4. [`plan/04-mobile-experience.md`](plan/04-mobile-experience.md) — build the richer mobile interaction experience.
5. [`plan/05-capacitor-checkpoint.md`](plan/05-capacitor-checkpoint.md) — decide later whether native packaging has enough concrete value.

Detailed tasks should be added to the active phase document as they become clear instead of maintaining a large card system.

## Explicitly out of scope for the current MVP

- Starting/resuming inactive sessions from the web.
- Writing directly to session JSONL files.
- Browser terminal/file editor/git workspace management.
- Multi-user or internet-facing hosting.
- Multi-machine federation.
- Mirroring arbitrary TUI-only extension dialogs.
