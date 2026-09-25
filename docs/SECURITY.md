# Security

## Threat model

A browser that controls pi-everywhere can prompt a Pi agent whose tools may execute shell commands, read/write files, use credentials available to the user, and incur model costs. Access is therefore comparable to SSH access, not to a normal chat website.

## Defaults

- HTTP binds to `127.0.0.1`.
- Non-loopback binding is refused unless `PI_EVERYWHERE_ALLOW_REMOTE=1` is explicitly set.
- Extensions connect through a Unix socket in a user-only directory; the socket mode is `0600`.
- A random 256-bit browser token is generated with file mode `0600`.
- Browser WebSocket upgrades require that token and a same-host Origin by default.
- Session content is not logged by the daemon.
- Browser rendering builds allowlisted DOM nodes from Markdown and literal tool text; it never injects untrusted HTML. Links are protocol-restricted and Markdown images are not loaded automatically.
- Web Push is disabled until a browser explicitly opts in. Subscriptions and the VAPID private key are stored in a `0600` state file under a `0700` directory.
- Push payloads are generic and contain no prompt, answer, thinking, cwd, or tool content. Browser push providers can still observe delivery timing and endpoint metadata.
- Maximum extension and WebSocket payload size is 2 MiB.
- Slow socket/WebSocket consumers are bounded; transient updates may be dropped and persistently congested connections are reconnected.

## Recommended remote access

Use Tailscale Serve while leaving the daemon on loopback:

```bash
tailscale serve --bg 8484
```

This gives tailnet transport encryption and identity/access policy without weakening the daemon's bind default. Do not use Tailscale Funnel or a public reverse proxy for this MVP.

## Token handling

Default location:

```text
~/.config/pi-everywhere/token
```

The PWA stores the token in `sessionStorage`, so closing the tab/browser session removes it. In the MVP it is included in the WebSocket URL query. The daemon does not log request URLs, but an upstream reverse proxy might. A future protocol should authenticate in the first WebSocket message or use a short-lived exchange token.

Rotate the token by stopping the daemon, deleting the token file, and restarting it. Push subscriptions are bound to a hash of that token and are cleared on restart after rotation.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `PI_EVERYWHERE_HOST` | HTTP bind address | `127.0.0.1` |
| `PI_EVERYWHERE_PORT` | HTTP port | `8484` |
| `PI_EVERYWHERE_ALLOW_REMOTE` | Permit non-loopback bind when set to `1` | unset |
| `PI_EVERYWHERE_ALLOWED_ORIGINS` | Comma-separated additional browser origins | unset |
| `PI_EVERYWHERE_SOCKET` | Extension/daemon Unix socket path | XDG runtime path |
| `PI_EVERYWHERE_TOKEN_FILE` | Browser token file | XDG config path |
| `PI_EVERYWHERE_PUSH_STATE_FILE` | Private VAPID key and push subscriptions | `$XDG_CONFIG_HOME/pi-everywhere/push.json` |
| `PI_EVERYWHERE_VAPID_SUBJECT` | VAPID contact URI | `mailto:pi-everywhere@example.invalid` |
| `PI_EVERYWHERE_ROOT` | Project root containing `web/` | auto-detected |

## Known gaps

- No rate limiting.
- No per-device or per-session authorization.
- No audit log.
- Token appears in the WebSocket query string.
- Push authorization is global rather than scoped per device or session, and delivery depends on external browser push providers.
- Explicit non-loopback mode relies on the same static token and is not the recommended deployment.
