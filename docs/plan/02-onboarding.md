# Phase 2 — Setup, service, and pairing

## Goal

Make first-time setup feel like: run one command, scan a QR code, and open the installed PWA.

## Planned work

- [ ] Choose a publishable package name and define the supported installation command.
- [x] Add initial `setup`, `doctor`, and `status` flows.
- [x] Install and manage a persistent daemon with a systemd user service; consider LaunchAgent and Home Manager support separately.
- [x] Detect Tailscale and guide configuration, with explicit `setup --tailscale` opt-in to configure Serve without exposing the daemon publicly.
- [ ] Replace manual shared-token entry with short-lived QR pairing.
- [ ] Give each paired device a persistent, revocable credential.
- [ ] Provide a simple way to list and revoke paired devices.
- [ ] Guide PWA installation and notification permission on iOS and Android.

## Implementation log

### 2026-09-25 — Linux service foundation

- Added a CLI with `setup`, `status`, `doctor`, and foreground `serve` commands.
- `setup` installs the current package path through Pi, writes a private systemd user unit, enables/restarts it, and verifies daemon health.
- `status` reports service enablement/activity, daemon health, live-process count, and the matching Tailscale Serve URL.
- `doctor` checks Node, Pi package registration, systemd, daemon health, credential permissions, Tailscale connectivity, and Serve routing.
- Migrated the development machine from a manual tmux daemon to `pi-everywhere.service`; all eight live Pi processes reconnected and the existing tailnet-only Serve route remained healthy.
- Package publication naming, QR exchange, and per-device credentials remain separate work.

## Completion signal

A new user can install pi-everywhere and pair one phone without manually starting the daemon, locating a token file, or editing configuration.

## Security constraints

- Browser control remains equivalent to shell access.
- The HTTP server remains loopback-only by default.
- Pairing codes must be short-lived and single-use.
- Credentials must be revocable without replacing every device credential.
