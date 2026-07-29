---
name: add-agenthost-process
description: Run NanoClaw agents as local child processes (no Docker) via nanoclaw-agenthost-process on top of nanoclaw-agenthosts.
---

# /add-agenthost-process — Local process RuntimeDriver

Registers a `process` RuntimeDriver with `nanoclaw-agenthosts` so selected agent groups spawn `bun` on the host instead of Docker.

Addresses community needs for native tools (tmux, headed browsers, macOS TCC) and no-Docker installs — with an **honest isolation trade-off**.

See also: [QUICKSTART.md](../../QUICKSTART.md) in the npm package.

## Prerequisites

- Working NanoClaw v2 install with `pnpm`
- Node.js ≥ 20 (22 recommended)
- **`nanoclaw-agenthosts` API v1** installed and verified in the fork
- `bun` available on `PATH` (or set `NANOCLAW_BUN_BIN`)
- Provider CLIs (`codex`, `claude`, …) on the host — process wake prepends Homebrew/`~/.bun/bin`/`~/.local/bin` because LaunchAgents often omit them. Override with `NANOCLAW_PROCESS_PATH_PREFIX`.

## When to use vs Docker

| Use process                            | Prefer Docker / Apple Container |
| -------------------------------------- | ------------------------------- |
| Validating agenthosts without a daemon | Untrusted channel content       |
| Native host tools (GUI, TCC, tmux)     | Multi-tenant / shared hosts     |
| Lightweight CI proof of RuntimeDriver  | Strong filesystem isolation     |

**Security:** process mode runs agent code as the **host user** for configured paths. Mount allowlists only help if the driver enforces path checks. Limit which groups use `runtime=process`. Designed for a **single-operator macOS** host — not multi-tenant / shared-host.

Wakes also require `NANOCLAW_ALLOW_PROCESS_RUNTIME=1` on the host (NanoClaw `.env` preferred — process boot applies it when unset, same pattern as `SESSIONIO_*`) so a casual `--runtime process` flip cannot remove the sandbox alone.

## Architecture

```
host wake → resolveRuntimeDriver(session)
                ↓
         process driver (this package)
                ↓
         spawn bun + WORKING_ROOT=sessionDir
                ↓
         filesystem mailbox (inbound.db / outbound.db)
```

Does **not** patch `wakeContainer` / `killContainer` — agenthosts owns those call sites.

## Recipe order

```
/add-agenthosts           # required substrate
/add-agenthost-process    # this skill
```

## Install

### Pre-flight (idempotent)

Skip to **Enable** if:

- `src/process-boot.ts` and `src/process-runtime.ts` exist
- `src/index.ts` contains `startAgenthostProcess()`
- agent-runner has `@nanoclaw-agenthost-process:working-root-*` markers
- `nanoclaw-agenthost-process` is listed in `package.json`

### 0. Sync this skill (first time / after upgrade)

```bash
pnpm exec nanoclaw-agenthost-process sync-skill
```

### 1. Install npm package

Local (sandbox / sibling checkout):

```bash
pnpm agenthost-process:local
# or: pnpm add file:../nanoclaw-agenthost-process
```

Published:

```bash
pnpm agenthost-process:published
# or: pnpm add nanoclaw-agenthost-process
```

### 2. Install into the fork

```bash
pnpm exec nanoclaw-agenthosts verify   # must pass first
pnpm exec nanoclaw-agenthost-process install
pnpm install
pnpm run build
./container/build.sh                   # WORKING_ROOT patches are in the runner image
pnpm exec nanoclaw-agenthost-process verify
```

Restart the NanoClaw host.

## Enable

1. Host opt-in (required) — add to NanoClaw `.env`, then restart the host:

```bash
NANOCLAW_ALLOW_PROCESS_RUNTIME=1
```

(LaunchAgent / shell `export` also works; `.env` alone is enough because process boot copies the key into `process.env` when unset.)

2. Opt a group into process runtime (agenthosts config):

```bash
ncl groups config update --id <agent-group-id> --runtime process
```

Other groups stay on `docker` by default. After repeated fail-closed wakes the driver writes `.process.wake-blocked` under the session directory.

## OneCLI

Children still need credentialed egress:

- Driver calls `ensureAgent` + `getContainerConfig`
- Writes CA/stub files under `data/v2-sessions/.../.process-runtime/`
- Injects `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` (host paths — no docker `-v`)

Ensure `ONECLI_API_KEY` / `ONECLI_URL` are set on the host as usual. Set `GATEWAY_BASE_URL` so agents can reach the proxy from the host network.

## Resource limits

Best-effort only: optional `ulimit` / cgroup notes for operators. Process mode does **not** apply Docker CPU/memory flags.

## Verify

```bash
pnpm exec nanoclaw-agenthost-process verify
```

Smoke: message round-trip with Docker unused for that group; idle kill via `.heartbeat`; host logs contain the sandbox-reduced WARN.

## Uninstall

See [REMOVE.md](./REMOVE.md).
