# Sandbox smoke — nanoclaw-agenthost-process

Run from **nanoclaw-sandbox** after the agenthosts substrate is installed.

## Setup

```bash
pnpm agenthosts:local                 # prerequisite (other package)
pnpm agenthost-process:local
./container/build.sh
# restart NanoClaw host
pnpm exec nanoclaw-agenthost-process verify
ncl groups config update --id <agent-group-id> --runtime process
```

## Checklist

1. **FS round-trip** — send a channel message to the opted-in group; agent replies without Docker for that group.
2. **Idle kill** — confirm host-sweep stops the child when `.heartbeat` goes stale.
3. **OneCLI** — credentialed model call succeeds (CA files under `data/v2-sessions/.../.process-runtime/`).
4. **Isolation** — a second group left on `docker` still uses containers.
5. **WARN** — host logs include the sandbox-reduced privilege warning on process wake.

## Troubleshooting

- `install` fails on agenthosts tokens → run `pnpm agenthosts:local` / `verify` first.
- Child can't find DBs → confirm `WORKING_ROOT` patches (`pnpm exec nanoclaw-agenthost-process verify`) and rebuild container image for mixed runtimes.
- OneCLI refuse to spawn → check `ONECLI_API_KEY` / `ONECLI_URL` on the host.
