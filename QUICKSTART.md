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
# restart host
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

- [ ] Message round-trip without Docker for a `runtime=process` group
- [ ] Idle kill via host-sweep / `.heartbeat` still works
- [ ] OneCLI credentialed model call with process-materialized CA files
- [ ] Other groups remain on `docker`
- [ ] Host logs include sandbox-reduced WARN
