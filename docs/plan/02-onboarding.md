# Phase 2 — Setup, service, and pairing

## Goal

Make first-time setup feel like: run one command, scan a QR code, and open the installed PWA.

## Planned work

- [ ] Choose a publishable package name and define the supported installation command.
- [ ] Add `setup`, `doctor`, and `status` flows.
- [ ] Install and manage a persistent daemon with a systemd user service; consider LaunchAgent and Home Manager support separately.
- [ ] Detect Tailscale and guide or configure Tailscale Serve without exposing the daemon publicly.
- [ ] Replace manual shared-token entry with short-lived QR pairing.
- [ ] Give each paired device a persistent, revocable credential.
- [ ] Provide a simple way to list and revoke paired devices.
- [ ] Guide PWA installation and notification permission on iOS and Android.

## Completion signal

A new user can install pi-everywhere and pair one phone without manually starting the daemon, locating a token file, or editing configuration.

## Security constraints

- Browser control remains equivalent to shell access.
- The HTTP server remains loopback-only by default.
- Pairing codes must be short-lived and single-use.
- Credentials must be revocable without replacing every device credential.
