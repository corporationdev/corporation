# `corp-turn-runner`

One-shot sandbox process that:

1. Connects to local sandbox-agent (`http://127.0.0.1:5799` by default),
2. Resumes or creates a session,
3. Submits a canonical `session/prompt` request,
4. Streams observed `SessionEvent`s and final status back to a callback URL.

## Invocation

```bash
corp-turn-runner \
  --turn-id turn_123 \
  --session-id sess_123 \
  --agent codex \
  --prompt "fix failing tests" \
  --model-id anthropic/claude-sonnet-4 \
  --callback-url "https://your-server/rivet/gateway/<actor-id>/action/ingestTurnRunnerBatch" \
  --callback-token "<opaque-token>"
```

## Options (or env vars)

- `--turn-id` / `TURN_ID` (required)
- `--session-id` / `SESSION_ID` (required)
- `--agent` / `AGENT` (required)
- `--prompt` / `PROMPT` (required unless `--prompt-json` is provided)
- `--prompt-json` / `PROMPT_JSON` (JSON array of ACP content blocks)
- `--model-id` / `MODEL_ID` (optional)
- `--cwd` / `CWD` (optional session init cwd)
- `--agent-url` / `AGENT_URL` (default: `http://127.0.0.1:5799`)
- `--callback-url` / `CALLBACK_URL` (required)
- `--callback-token` / `CALLBACK_TOKEN` (required)
- `--callback-mode` / `CALLBACK_MODE` (`rivet-action` or `raw`, default: `rivet-action`)
- `--flush-interval-ms` / `FLUSH_INTERVAL_MS` (default: `75`)
- `--max-batch-size` / `MAX_BATCH_SIZE` (default: `10`)
- `--heartbeat-interval-ms` / `HEARTBEAT_INTERVAL_MS` (default: `15000`)
- `--callback-timeout-ms` / `CALLBACK_TIMEOUT_MS` (default: `10000`)
- `--callback-max-attempts` / `CALLBACK_MAX_ATTEMPTS` (default: `8`)

## Callback payloads

All callbacks include:

- `turnId`
- `sessionId`
- `token`
- `sequence` (monotonic per turn)
- `kind`
- `timestamp`

Kinds:

- `started`: `{ agent, modelId }`
- `events`: `{ events: SessionEvent[], lastEventIndex }`
- `heartbeat`: `{ lastEventIndex }`
- `completed`: `{ stopReason, lastEventIndex }`
- `failed`: `{ error, lastEventIndex }`

When `callback-mode=rivet-action`, request body is:

```json
{ "args": [<payload>] }
```

When `callback-mode=raw`, request body is the payload object itself.
