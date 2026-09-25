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

Other extension messages are `heartbeat` and `command_result`. The daemon removes a process when its socket closes. Heartbeat timeout eviction is planned but not implemented.

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

- `prompt`: inject a user message. `behavior` is used only while Pi is busy.
- `abort`: call the owning session context's abort operation.
- `snapshot`: request a fresh metadata/history snapshot.

## Daemon to browser

On connect:

```json
{ "v": 1, "type": "state", "agents": [] }
```

Incremental messages:

- `agent_upsert`: process connected or its snapshot changed.
- `agent_removed`: process socket closed.
- `agent_event`: structured Pi event.
- `command_result`: command accepted or rejected by the extension.
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
