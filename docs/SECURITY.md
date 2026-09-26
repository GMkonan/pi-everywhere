# Security

## Threat model

A browser that controls pi-everywhere can prompt a Pi agent whose tools may execute shell commands, read/write files, use credentials available to the user, and incur model costs. Access is therefore comparable to SSH access, not to a normal chat website.

## Defaults

- HTTP binds to `127.0.0.1`.
- Non-loopback binding is refused unless `PI_EVERYWHERE_ALLOW_REMOTE=1` is explicitly set.
- Extensions connect through a Unix socket in a user-only directory; the socket mode is `0600`.
- A random 256-bit browser token is generated with file mode `0600`.
- Browser WebSocket upgrades require a same-host Origin and then a valid credential in the first message. Short-lived pairing creates hashed, per-device credentials; the master-token query parameter remains only as a temporary legacy fallback.
- Session content is not logged by the daemon. The PWA fetches transcript history only for the selected live process, keeps a three-session in-memory cache, and does not persist history through the service worker.
- Browser rendering builds allowlisted DOM nodes from Markdown and literal tool text; it never injects untrusted HTML. Links are protocol-restricted and Markdown images are not loaded automatically.
- Web Push is disabled until a browser explicitly opts in. Subscriptions and the VAPID private key are stored in a `0600` state file under a `0700` directory.
- Push payloads are generic and contain no prompt, answer, thinking, cwd, or tool content. Browser push providers can still observe delivery timing and endpoint metadata.
- Maximum extension and WebSocket payload size is 2 MiB.
- Image prompts accept at most three attachments. The browser decodes and re-encodes them as JPEG at no more than 1600 px and 300 KiB each (900 KiB total), stripping original EXIF/GPS metadata; the daemon and extension independently validate canonical base64, JPEG signatures, MIME, count, and byte limits.
- Slow socket/WebSocket consumers are bounded; transient updates may be dropped and persistently congested connections are reconnected.
- Linux setup writes the systemd user unit with mode `0600` and runs the daemon with `UMask=0077`.

## Recommended remote access

Use Tailscale Serve while leaving the daemon on loopback:

```bash
tailscale serve --bg 8484
```

This gives tailnet transport encryption and identity/access policy without weakening the daemon's bind default. Do not use Tailscale Funnel or a public reverse proxy for this MVP.

## Credentials and pairing

The master token remains at:

```text
~/.config/pi-everywhere/token
```

It is used by the local CLI for administrative operations and remains accepted for manual migration access. New PWA connections authenticate in the first WebSocket message, so their credential is not present in the URL. The PWA stores its individual credential in `localStorage` for installed-app persistence.

`pi-everywhere pair` creates a random five-minute offer that is held only in daemon memory and can be exchanged once. The daemon stores only SHA-256 hashes of issued device credentials in a `0600` state file. Revocation closes active WebSockets and removes Push subscriptions owned by that device.

A pairing URL is temporarily equivalent to shell access until exchanged or expired. Display and scan it privately. Rotate the master token by stopping the daemon, deleting the token file, and restarting it; this still clears all Push subscriptions but does not implicitly revoke paired-device credentials.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `PI_EVERYWHERE_HOST` | HTTP bind address | `127.0.0.1` |
| `PI_EVERYWHERE_PORT` | HTTP port | `8484` |
| `PI_EVERYWHERE_ALLOW_REMOTE` | Permit non-loopback bind when set to `1` | unset |
| `PI_EVERYWHERE_ALLOWED_ORIGINS` | Comma-separated additional browser origins | unset |
| `PI_EVERYWHERE_SOCKET` | Extension/daemon Unix socket path | XDG runtime path |
| `PI_EVERYWHERE_TOKEN_FILE` | Browser token file | XDG config path |
| `PI_EVERYWHERE_PUSH_STATE_FILE` | Private VAPID key and device-owned push subscriptions | `$XDG_CONFIG_HOME/pi-everywhere/push.json` |
| `PI_EVERYWHERE_DEVICE_STATE_FILE` | Hashed paired-device credentials and metadata | `$XDG_CONFIG_HOME/pi-everywhere/devices.json` |
| `PI_EVERYWHERE_VAPID_SUBJECT` | VAPID contact URI | `mailto:pi-everywhere@example.invalid` |
| `PI_EVERYWHERE_ROOT` | Project root containing `web/` | auto-detected |

## Known gaps

- No rate limiting.
- Device credentials grant access to every live Pi process; there is no per-session authorization.
- No audit log.
- The master token is still accepted in the WebSocket query string for legacy clients during migration.
- Push delivery depends on external browser push providers.
- Explicit non-loopback mode relies on the same static token and is not the recommended deployment.
