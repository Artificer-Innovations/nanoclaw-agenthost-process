# nanoclaw-agenthost-process

Local **child-process** `RuntimeDriver` for [nanoclaw-agenthosts](https://github.com/Artificer-Innovations/nanoclaw-agenthosts). Run agent-runners with `bun` on the host — no Docker daemon required for opted-in groups.

## Peer dependency

Requires **`nanoclaw-agenthosts` API v1** installed in the NanoClaw fork (`pnpm exec nanoclaw-agenthosts verify`). Declared as an optional npm peer until that package is published; install/verify still fail closed via filesystem token checks.

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

## Security

Process mode trades isolation for capability. Agents run as the **host user**. Prefer Docker/Apple Container for untrusted channel content; limit which groups use `process`.

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
```

Sandbox peer loop (in a NanoClaw fork such as nanoclaw-sandbox):

```bash
pnpm agenthosts:local              # substrate first
pnpm agenthost-process:local
pnpm exec nanoclaw-agenthost-process verify
```
