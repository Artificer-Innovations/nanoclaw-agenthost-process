# nanoclaw-agenthost-process

A **process** `RuntimeDriver` plugin for [nanoclaw-agenthosts](https://github.com/Artificer-Innovations/nanoclaw-agenthosts).

It runs each opted-in agent as a local `bun` child process on the NanoClaw host machine — no Docker daemon for those groups. That makes this package a concrete **proof of concept** of what agenthosts enables: pluggable runtimes so the host can wake/kill agents without assuming “local Docker container.”

## Why this exists

[nanoclaw-agenthosts](https://github.com/Artificer-Innovations/nanoclaw-agenthosts) turns NanoClaw’s container lifecycle into a registry. Drivers can target different container platforms, sibling processes on the same box, or (with a network mailbox such as [nanoclaw-sessionio](https://github.com/Artificer-Innovations/nanoclaw-sessionio)) agents on other physical machines.

This package is the smallest end-to-end example of that model: install agenthosts, install this plugin, set a group to `--runtime process`, and the host dispatches through the registry instead of hard-coded Docker APIs.

Useful when you need:

- **A reference agenthost** — see how a non-Docker `RuntimeDriver` registers, wakes, kills, and cleans up orphans
- **Host-native tools** — agents that must use the operator’s PATH, Homebrew CLIs, macOS TCC APIs, headed browsers, or other capabilities containers do not expose cleanly
- **A lighter local loop** — develop or debug agenthosts wiring without requiring a working Docker runtime for every group
- **A stepping stone** — validate host↔agent session transports and multi-machine topology ideas before building a remote or alternate-container driver

## Important trade-off

NanoClaw’s default design isolates each agent in a **container**. Process mode **removes that isolation**: the agent runs as the **host user** with access to whatever that account can reach.

Prefer Docker (or another sandboxed runtime) for untrusted channel content. Use `process` only when you have a deliberate need for non-contained agents, and limit which groups opt in.

## Dependency

Requires **`nanoclaw-agenthosts` API v1** installed and verified in the NanoClaw fork first (`pnpm exec nanoclaw-agenthosts verify`). This package does not replace agenthosts — it registers one driver on top of it.

Declared as an optional npm peer until agenthosts is published; install/verify still fail closed via filesystem token checks.

## Quick install

```bash
pnpm add nanoclaw-agenthosts nanoclaw-agenthost-process
pnpm exec nanoclaw-agenthosts install
pnpm exec nanoclaw-agenthost-process install
pnpm run build && ./container/build.sh
pnpm exec nanoclaw-agenthost-process verify
```

Opt in a group:

```bash
ncl groups config update --id <id> --runtime process
```

## Docs

- [QUICKSTART.md](./QUICKSTART.md)
- [api-contract.md](./api-contract.md)
- Skill: `/add-agenthost-process` after `sync-skill`

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run build
pnpm run test:integration
```

Sandbox peer loop (in a NanoClaw fork such as nanoclaw-sandbox):

```bash
pnpm agenthosts:local              # substrate first
pnpm agenthost-process:local
pnpm exec nanoclaw-agenthost-process verify
```
