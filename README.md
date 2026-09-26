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

## Linux setup from a checkout

Requirements: Node.js 22+, npm, Pi 0.84.1+, and a systemd user session.

```bash
npm install
npm run setup
```

This builds the project, installs the checkout as a global Pi package, and enables `pi-everywhere.service` as a persistent user service. Existing Pi TUIs can then load the extension with `/reload`; new Pi processes load it automatically.

Pair a phone with a short-lived, single-use QR code:

```bash
npm run pair
```

The installed PWA keeps its own revocable device credential, so the master token does not need to be copied. Manage paired devices with `npm run devices` and `npm run revoke -- <device-id>`.

Useful lifecycle checks:

```bash
npm run status
npm run doctor
```

If Tailscale is installed and you explicitly want setup to configure Serve as well:

```bash
npm run setup -- --tailscale
```

The server remains on `127.0.0.1:8484`; Tailscale Serve provides private phone access without changing the bind address.

## Development setup

To run the daemon in the foreground instead of installing the service:

```bash
npm install
npm run check
npm run dev:server
```

The in-progress Svelte compatibility build can be tested explicitly without replacing the production frontend:

```bash
npm run build:web
PI_EVERYWHERE_WEB_ROOT="$PWD/web-dist" npm run dev:server
```

Install this checkout as a local Pi package when it is not already registered:

```bash
pi install /home/konan/code/projects/pi-everywhere
```

Then start a new Pi process or run `/reload` inside an existing one.

The TUI footer should show `everywhere: connected` while the daemon is available.

Open `http://127.0.0.1:8484`. QR pairing is preferred; manual entry of the master token remains available temporarily for migration and development. If `XDG_CONFIG_HOME` is set, state is stored below that directory instead.

## Phone access with Tailscale

Keep the daemon bound to loopback and publish it through Tailscale Serve:

```bash
tailscale serve --bg 8484
tailscale serve status
```

Open the HTTPS URL shown by Tailscale on the phone. Do not expose this service publicly: controlling Pi is effectively equivalent to shell access under your user account.

Notifications are opt-in from the bell button and require a secure browser context. On iOS/iPadOS, install the PWA to the Home Screen (16.4 or newer). Closed-app delivery uses the browser vendor's push service, so the daemon needs outbound internet access.

In the prompt composer, Enter inserts a new line. Use the arrow button or Ctrl/⌘+Enter to send.

## Commands

```bash
npm run dev          # server with file watching
npm run dev:server   # server once, through tsx
npm run setup        # build and install the Linux systemd user service
npm run status       # report service, daemon, and Tailscale state
npm run doctor       # diagnose setup problems
npm run pair         # create a five-minute, single-use pairing QR code
npm run devices      # list paired phones/browsers
npm run revoke -- ID # revoke a device and its push subscription
npm run typecheck
npm run check:web    # validate Svelte and legacy browser modules
npm run build:web    # build the opt-in Svelte compatibility frontend
npm test
npm run build
npm run check        # typecheck + Svelte/browser checks + tests + builds
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
