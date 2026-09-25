# pi-everywhere

Use the **same live Pi process** from its terminal UI and from a mobile-friendly web interface.

Unlike RPC frontends, pi-everywhere does not start a second Pi process or reopen a session file. A Pi extension connects the already-running TUI process to a local bridge daemon, so prompts sent from the phone appear in that exact Pi instance.

> Status: early MVP. The protocol and UX will change.

## What works

- Existing Pi TUI processes can join after `/reload`.
- Full-screen session navigation groups connected processes by activity date and orders each group newest-first.
- Active-branch history is synchronized and opens at the latest message.
- Thinking, tool activity, and final answers have separate presentation; final conversation text renders safe Markdown with a Catppuccin Mocha palette.
- A lightweight animated status above the composer shows when the selected Pi process is working.
- Optional Web Push notifications report when a working session settles, including while an installed PWA is closed.
- The mobile composer keeps prompting intentionally simple and queues messages with `followUp` while Pi is busy.
- Prompts go directly to the selected Pi process.
- Busy sessions support follow-up or steering delivery.
- The current run can be aborted remotely.
- The web UI is installable as a PWA.
- The daemon is loopback-only and browser access requires a generated token.

## Development setup

Requirements: Node.js 22+, npm, and Pi 0.84.1+.

```bash
npm install
npm run check
npm run dev:server
```

The server listens on `http://127.0.0.1:8484`. It prints the paths of its Unix socket and browser token.

In another terminal, install this checkout as a local Pi package:

```bash
pi install /home/konan/code/projects/pi-everywhere
```

Then:

- start a new Pi process, or
- run `/reload` inside an already-running Pi process.

The TUI footer should show `everywhere: connected` while the daemon is available.

Open `http://127.0.0.1:8484`, then paste the token from:

```bash
cat ~/.config/pi-everywhere/token
```

If `XDG_CONFIG_HOME` is set, the token is stored below that directory instead.

## Phone access with Tailscale

Keep the daemon bound to loopback and publish it through Tailscale Serve:

```bash
tailscale serve --bg 8484
tailscale serve status
```

Open the HTTPS URL shown by Tailscale on the phone. Do not expose this service publicly: controlling Pi is effectively equivalent to shell access under your user account.

Notifications are opt-in from the bell button and require a secure browser context. On iOS/iPadOS, install the PWA to the Home Screen (16.4 or newer). Closed-app delivery uses the browser vendor's push service, so the daemon needs outbound internet access.

## Commands

```bash
npm run dev          # server with file watching
npm run dev:server   # server once, through tsx
npm run typecheck
npm test
npm run build
npm run check        # typecheck + tests + build
npm start            # run compiled server after npm run build
```

## Project documentation

- [`AGENTS.md`](AGENTS.md): concise context and rules for coding agents.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components and lifecycle.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md): wire messages.
- [`docs/SECURITY.md`](docs/SECURITY.md): threat model and safe exposure.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): MVP boundary and next steps.

## Naming note

The repository/project is called **pi-everywhere**. The unscoped npm name `pi-everywhere` is already owned by an unrelated package, so this package is private and currently named `pi-everywhere-local`. Choose a scope before publishing.
