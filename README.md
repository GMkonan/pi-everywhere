<p align="center">
  <img src="frontend/public/icon-192.png" width="112" height="112" alt="pi-everywhere robot icon" />
</p>

<h1 align="center">pi-everywhere</h1>

<p align="center">
  Control the <strong>exact Pi process already running in your terminal</strong> from a phone or browser.
</p>

<p align="center">
  <strong>Pi TUI</strong> ↔ local bridge ↔ installable mobile PWA
</p>

pi-everywhere adds a second, mobile-friendly interface to your existing [Pi](https://github.com/badlogic/pi-mono) TUI session. It does not start another agent or reopen the same session file in a second process: prompts, streaming output, tools, history, and cancellation stay attached to the live Pi instance you selected.

> [!IMPORTANT]
> This is an early Linux-focused project. Browser access can control an AI agent with your user's shell permissions, so keep the daemon private and use Tailscale for remote access.

## Highlights

- Switch between all currently connected Pi processes.
- Read live responses, thinking, tools, safe Markdown, and paged history.
- Send follow-up prompts and up to three normalized image attachments.
- Keep a separate in-memory text draft for each session.
- Stop an active Pi run remotely.
- Receive optional completion notifications from the installed PWA.
- Choose between four persistent color themes.
- Pair browsers with short-lived QR codes and revoke devices later.
- Preserve the original terminal workflow—the Pi TUI remains the primary process.

## Quick start

### Requirements

- Linux with a systemd user session
- Node.js 22 or newer
- npm
- Pi 0.84.1 or newer
- [Tailscale](https://tailscale.com/download) for private phone access

### 1. Install

```bash
git clone https://github.com/GMkonan/pi-everywhere.git
cd pi-everywhere
npm install
npm run setup -- --tailscale
```

Setup builds the daemon and Svelte PWA, installs this checkout as a Pi package, and starts the `pi-everywhere.service` user service.

If Tailscale Serve is already configured, `--tailscale` can be omitted. To use the browser only on the same computer, run `npm run setup` and open `http://127.0.0.1:8484`.

### 2. Load the extension

Start a new Pi process. For Pi terminals that were already open during installation, run:

```text
/reload
```

The footer robot is green and happy when the bridge is connected: `[•ᴗ•]`.

### 3. Pair your phone

```bash
npm run pair
```

Scan the QR code, open the generated HTTPS address, and optionally install the page on your Home Screen. Pairing links are single-use and expire after five minutes.

## Everyday commands

```bash
npm run status                 # service health and phone URL
npm run doctor                 # diagnose installation problems
npm run pair                   # pair another browser
npm run devices                # list paired devices
npm run revoke -- <device-id>  # revoke a paired device
npm run setup -- --tailscale   # rebuild, reinstall, and restart
```

After pulling a new version, run `npm install` followed by `npm run setup -- --tailscale`.

## Using the PWA

- Select a live Pi process from **Sessions**.
- Enter creates a new line; the arrow button or Ctrl/⌘+Enter sends the prompt.
- Prompts sent while Pi is busy are delivered as follow-ups.
- The stop icon appears beside the working indicator only while the selected Pi process is active.
- History is loaded in small pages and cached only in browser memory.
- Image attachments are resized and converted to bounded JPEGs before being sent.

## How it works

```text
Pi TUI + extension
        │  NDJSON over a Unix socket
        ▼
Local bridge daemon
        │  authenticated WebSocket + HTTP
        ▼
Svelte PWA on your browser or phone
```

The extension subscribes to structured Pi events and injects remote prompts with Pi's extension API. The daemon routes commands by live `instanceId`, serves the PWA, and never opens Pi session files for writing.

## Security

The HTTP server binds to `127.0.0.1:8484` by default. Do not expose it directly to the public internet. Tailscale Serve is the recommended remote transport:

```bash
tailscale serve --bg 8484
tailscale serve status
```

Treat paired browser credentials like shell credentials. See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model and deployment guidance.

## Development

```bash
npm install
npm run dev:server     # run the daemon from TypeScript
npm run build:web      # build the Svelte PWA
npm run check          # typecheck, tests, and production builds
```

For a foreground daemon serving the production frontend:

```bash
npm run build:web
PI_EVERYWHERE_WEB_ROOT="$PWD/web-dist" npm run dev:server
```

Useful documentation:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components and lifecycle
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — bridge protocol
- [`docs/SECURITY.md`](docs/SECURITY.md) — authentication and exposure
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — current scope and next steps

## Project status

pi-everywhere is an early MVP and its protocol and interface may still change. Automated service installation currently supports Linux/systemd only. The npm package remains private because the unscoped `pi-everywhere` name is owned by an unrelated package; installation from this Git checkout is the supported path.
