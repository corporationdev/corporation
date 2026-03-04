# `corp-turn-runner`

One-shot sandbox process that:

1. Connects to local sandbox-agent (`http://127.0.0.1:5799` by default),
2. Resumes or creates a session,
3. Submits a canonical `session/prompt` request,
4. Streams observed `SessionEvent`s and final status back to a callback URL.

## Environment variables

Required:

- `TURN_ID`
- `SESSION_ID`
- `AGENT`
- `PROMPT_JSON` (JSON array of ACP content blocks)
- `CALLBACK_URL`
- `CALLBACK_TOKEN`

Optional:

- `MODEL_ID`
- `CWD` (session init cwd)
- `AGENT_URL` (default: `http://127.0.0.1:5799`)
- `FLUSH_INTERVAL_MS` (default: `75`)
- `MAX_BATCH_SIZE` (default: `10`)
- `CALLBACK_TIMEOUT_MS` (default: `10000`)
- `CALLBACK_MAX_ATTEMPTS` (default: `8`)

## Callback payloads

All callbacks include `turnId`, `sessionId`, `token`, `sequence`, `kind`, `timestamp`.

Request body is wrapped for Rivet actions: `{ "args": [<payload>] }`.

Kinds:

- `events`: `{ events: SessionEvent[] }`
- `completed`: `{}`
- `failed`: `{ error: { name, message, stack } }`

## Testing in a sandbox without the base template

If you need to test changes to the script before rebuilding the base template, you can manually install it into a running sandbox:

```bash
# Copy files into the sandbox
e2b sandbox cp scripts/turn-runner/ <sandbox-id>:/opt/corporation/turn-runner/

# Install deps and symlink the executable
e2b sandbox exec <sandbox-id> -- bash -c '
  cd /opt/corporation/turn-runner &&
  npm install --omit=dev --no-audit --no-fund &&
  chmod +x corp-turn-runner.mjs &&
  ln -sf /opt/corporation/turn-runner/corp-turn-runner.mjs /usr/local/bin/corp-turn-runner
'
```
