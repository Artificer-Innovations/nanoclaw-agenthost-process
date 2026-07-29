# Quickstart — nanoclaw-agenthost-process

## Prerequisites

1. NanoClaw v2 fork (`src/index.ts` + `src/channels/index.ts`)
2. `nanoclaw-agenthosts` installed and `pnpm exec nanoclaw-agenthosts verify` green
3. Node 20+, `bun` on PATH

## Local loop (nanoclaw-sandbox)

```bash
# From nanoclaw-sandbox (sibling of this repo)
pnpm agenthosts:local                 # when available
pnpm agenthost-process:local          # builds + file: link + install
pnpm exec nanoclaw-agenthost-process verify
./container/build.sh
# Host opt-in (required — per-group flag alone will not wake)
# Prefer NanoClaw .env; process boot applies this key when unset (like SESSIONIO_*).
# Keep .env mode 0600 / owner-only and gitignored. process.env wins if already set.
echo 'NANOCLAW_ALLOW_PROCESS_RUNTIME=1' >> .env
chmod 600 .env
# restart host / LaunchAgent
ncl groups config update --id <id> --runtime process
```

Published:

```bash
pnpm agenthost-process:published
# or: AGENTHOST_PROCESS_VERSION=0.1.0 pnpm agenthost-process:published
```

Rebuild after editing this package:

```bash
pnpm agenthost-process:rebuild-local
```

Check which source is linked:

```bash
pnpm agenthost-process:source
```

## Manual install

```bash
pnpm add file:../nanoclaw-agenthost-process   # or npm version
pnpm exec nanoclaw-agenthost-process sync-skill
pnpm exec nanoclaw-agenthost-process install
pnpm run build
./container/build.sh
pnpm exec nanoclaw-agenthost-process verify
```

## Smoke checklist

- [ ] `NANOCLAW_ALLOW_PROCESS_RUNTIME=1` in NanoClaw `.env` (or host env) before wake — `.env` should be `0600` and gitignored
- [ ] Message round-trip without Docker for a `runtime=process` group
- [ ] Idle kill via host-sweep / `.heartbeat` still works
- [ ] OneCLI credentialed model call with process-materialized CA files
- [ ] Other groups remain on `docker`
- [ ] Host logs include sandbox-reduced WARN
- [ ] Misconfig writes `.process.wake-blocked` after repeated fail-closed wakes

## Process Codex homes

Per-group `CODEX_HOME` (`data/v2-sessions/<id>/.codex-shared/`) is host-managed. On wake the process driver normalizes `config.toml` (file credential stores + `[features].secret_auth_storage = false`) via a TOML parse → mutate → stringify. Comments and key order are not preserved — treat the file as host-owned, not hand-edited. Concurrent writers in one host are serialized with an in-process lock; cross-host multi-process locking is out of scope for 0.1.0 (single LaunchAgent host).
