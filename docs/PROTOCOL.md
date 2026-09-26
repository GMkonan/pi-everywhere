# Protocol

Protocol version: `1`.

The extension/daemon transport is strict LF-delimited JSON (NDJSON) over a Unix stream socket. Browser traffic is one JSON object per WebSocket message. Payloads are capped at 2 MiB.

This document describes the MVP protocol; it is not stable yet.

## Identity

- `instanceId`: random identifier for one live Pi extension/process instance. Commands route by this field.
- `sessionId`: Pi's persisted session UUID. It is metadata only and is not unique among live processes.
- `commandId`: browser-generated UUID used to correlate command results.

## Extension to daemon

The first message on every extension socket must be `hello`:

```json
{
  "v": 1,
  "type": "hello",
  "instanceId": "1234-uuid",
  "snapshot": {
    "meta": {
      "instanceId": "1234-uuid",
      "pid": 1234,
      "cwd": "/home/user/project",
      "sessionId": "session-uuid",
      "sessionName": "Fix auth",
      "model": "openai-codex/gpt-5.6",
      "thinkingLevel": "high",
      "idle": true
    },
    "entries": [],
    "capturedAt": 1789600000000,
    "historyTruncated": false
  }
}
```

Incremental Pi event:

```json
{
  "v": 1,
  "type": "event",
  "instanceId": "1234-uuid",
  "sequence": 7,
  "event": { "type": "agent_start" }
}
```

Fresh durable snapshot:

```json
{
  "v": 1,
  "type": "snapshot",
  "instanceId": "1234-uuid",
  "snapshot": { "meta": {}, "entries": [], "capturedAt": 1789600000000 }
}
```

Other extension messages are `heartbeat` and `command_result`. The daemon removes a process when its socket closes or when no message/heartbeat has been seen for 45 seconds.

## Daemon to extension

```json
{
  "v": 1,
  "type": "command",
  "instanceId": "1234-uuid",
  "commandId": "command-uuid",
  "command": "prompt",
  "payload": {
    "text": "Run the tests",
    "behavior": "followUp"
  }
}
```

Commands:

- `prompt`: inject a user message. The payload must contain trimmed text or up to three validated JPEG images; `behavior` is used only while Pi is busy. Images are bare canonical base64 with `mimeType: "image/jpeg"`, at most 300 KiB each and 900 KiB combined.
- `abort`: call the owning session context's abort operation.
- `snapshot`: request a fresh metadata/history snapshot.

## Browser authentication and pairing

New browser clients open `/ws` without a credential in the URL and authenticate as their first WebSocket message:

```json
{ "v": 1, "type": "authenticate", "credential": "device-credential", "capabilities": ["lazy-history-v1", "paged-history-v1"] }
```

The daemon answers with `authenticated` and then begins state transfer. A five-second timeout closes sockets that do not authenticate. `lazy-history-v1` advertises support for the metadata-only index and on-demand transcript messages; `paged-history-v1` adds bounded newest-first transcript pages. During one migration window, clients without that capability receive the previous eager full-history state/upserts so an already-running suspended PWA remains usable. During migration only, a valid master token in the legacy WebSocket query parameter is still accepted.

Pairing uses HTTP:

- `POST /api/admin/pairings`: master-token-only; creates a five-minute, single-use pairing URL.
- `POST /api/pair/exchange`: exchanges the secret from that URL for a persistent device credential.
- `GET /api/admin/devices`: master-token-only device list.
- `DELETE /api/admin/devices/:id`: revokes the credential, closes its active sockets, and removes its Push subscriptions.

Pairing secrets live only in daemon memory. Device credential hashes and non-secret metadata are persisted; plaintext device credentials are returned once to the pairing browser.

## Daemon to browser

After authentication, a `lazy-history-v1` browser receives one or more bounded, metadata-only state chunks:

```json
{ "v": 1, "type": "state", "agents": [], "reset": true, "complete": true }
```

`reset: true` starts a fresh registry transfer and `complete: true` ends it. Every indexed agent has `historyLoaded: false`, an empty `snapshot.entries`, and a daemon-maintained `lastActivityAt` so the session list can sort correctly without transcript content.

When a session is selected, the browser requests only that live process's history:

```json
{ "v": 1, "type": "history_request", "instanceId": "1234-uuid", "requestId": "request-uuid", "limit": 40 }
```

The daemon responds only to that browser and treats it as the browser's current history watch:

```json
{ "v": 1, "type": "agent_history", "instanceId": "1234-uuid", "requestId": "request-uuid", "page": { "offset": 0, "count": 40, "hasOlder": true }, "agent": {} }
```

The response's agent has `historyLoaded: true`, a connection `generation`, a `snapshotSequence` watermark, and its bounded page. Older requests supply `offset`, `limit`, `generation`, and `snapshotSequence`; stale watermarks are rejected so mutable snapshots cannot shift page boundaries underneath a request. Paging does not alter the snapshot's permanent `omittedEntries` count. Incremental `agent_event` messages carry the same generation and their extension sequence. Events arriving while the initial history is in flight are bounded and replayed only when they belong to that generation and are newer than the snapshot watermark. If the watched process later publishes a fresh finalized snapshot, the daemon sends another `agent_history` with the same request ID only to watching browsers. Switching sessions replaces the watch. An unavailable or oversized history produces `agent_history_error`. Oversized history is trimmed from the oldest end and reports additional omissions through normal snapshot truncation metadata.

Incremental messages:

- `agent_upsert`: process metadata changed; transcript entries remain omitted.
- `agent_removed`: process disconnected or exceeded the heartbeat liveness timeout.
- `agent_event`: structured Pi event.
- `command_result`: command accepted or rejected by the extension. Results are routed only to the browser that originated the matching `commandId`; pending commands fail on timeout or process disconnection.
- `error`: browser command/protocol error.

The browser uses the same command shape shown above.

## Notification HTTP API

Optional Web Push registration uses the same bearer token as `/api/auth`:

- `GET /api/push/public-key`: return the daemon's public VAPID key.
- `PUT /api/push/subscription`: register or replace a browser `PushSubscription`; requires an allowed `Origin`.
- `DELETE /api/push/subscription`: remove a subscription by endpoint; requires an allowed `Origin`.

Push payloads are generic `agent_settled` notices keyed by live `instanceId`; they never contain session content. These endpoints do not change the WebSocket protocol version.

## Serialization

Pi events and extension/tool data are not assumed to be safe JSON. Before sending, the extension:

- converts BigInt and Error values;
- marks circular references;
- limits depth, array length, object keys, and string length;
- omits functions, symbols, and undefined values;
- drops any final message larger than 2 MiB.

Snapshots are limited by both entry count and encoded byte budget. If older entries are omitted, `historyTruncated` and `omittedEntries` explain the partial history. Finalized session snapshots are authoritative after reconnection. Streaming events are intentionally ephemeral and may be dropped under backpressure.
