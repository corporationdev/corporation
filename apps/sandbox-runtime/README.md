# Sandbox Runtime Stream Protocol

`sandbox-runtime` exposes two layers over websocket:

- commands
- durable event streams

Commands are runtime-specific. Event streaming is modeled on Durable Streams semantics, but transported over websocket instead of HTTP.

## Public Commands

The current public command contract is:

- `create_session`
- `prompt`
- `abort`
- `respond_to_permission`

Commands are deduped by `requestId`. If a caller retries the same command with the same `requestId`, the runtime replays the stored outcome instead of executing the command again.

## Stream Model

Every emitted runtime event belongs to a durable stream.

Today the public stream shape is:

- `session:${sessionId}`

Each persisted event has a durable `offset`. Offsets are monotonic within a stream and are exposed as strings so clients do not depend on the internal SQLite representation.

## Subscribe

Clients resume by sending the last durable offset they have already processed.

```json
{
  "type": "subscribe_stream",
  "stream": "session:session-1",
  "offset": "5"
}
```

That means: "give me everything after offset `5`."

Supported sentinel offsets:

- `"-1"`: start from the beginning of the stream
- `"now"`: start at the current tail and only receive future items

## Stream Frames

The runtime responds with `stream_items` frames:

```json
{
  "type": "stream_items",
  "stream": "session:session-1",
  "items": [
    {
      "offset": "6",
      "eventId": "evt-123",
      "commandId": "req-2",
      "createdAt": 1773428533043,
      "event": {
        "type": "turn.completed",
        "sessionId": "session-1",
        "turnId": "turn-1"
      }
    }
  ],
  "nextOffset": "6",
  "upToDate": true,
  "streamClosed": false
}
```

Semantics:

- `items`: the next durable events after the requested offset
- `nextOffset`: the offset a consumer should store after durably applying the batch
- `upToDate`: the runtime has caught the consumer up for now
- `streamClosed`: the stream is permanently closed

Right now session streams are long-lived, so `streamClosed` is expected to remain `false`.

## Consumer Rules

To avoid losing events, consumers should:

1. Read their previously stored offset from durable storage.
2. Subscribe with that offset.
3. Apply each `stream_items` batch.
4. Persist the new `nextOffset` in the same durable transaction as the applied state.

The critical rule is:

- state changes and offset advancement must commit atomically

If the consumer crashes:

- before commit: the offset does not advance, so replay re-delivers the batch
- after commit: the stored offset is already advanced, so replay resumes after it

This gives at-least-once delivery with no event loss, assuming the consumer is durable.

## What The Runtime Persists

The runtime persists:

- `runtime_event_log`: durable event history by stream
- `runtime_command_receipts`: command dedupe and stored outcomes

The runtime does **not** persist consumer acknowledgement state. Consumers are responsible for storing their own last processed offset.

## Recommended Durable Object Consumer Shape

For a Durable Object consumer:

1. Persist `lastProcessedOffset` in the DO's own SQLite.
2. On reconnect, send:

```json
{
  "type": "subscribe_stream",
  "stream": "session:session-1",
  "offset": "5"
}
```

3. When a `stream_items` frame arrives, apply `items` and store `nextOffset` in one transaction.

That is the intended recovery path for `EnvironmentDO` and downstream consumers.
