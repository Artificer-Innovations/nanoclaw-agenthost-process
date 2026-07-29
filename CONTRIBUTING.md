# Contributing

## Branches

- `develop` — integration
- `main` — release (publishes to npm)

## Workflow

1. Branch from `develop`
2. `pnpm install && pnpm run test:coverage && pnpm run lint && pnpm run build`
3. Add a changeset for user-facing changes (`pnpm changeset`)
4. Open a PR into `develop`

## Package layout

- `packages/cli` — installer
- `packages/host` — driver sources copied into NanoClaw forks
- `skills/add-agenthost-process` — Claude skill + resources mirror
