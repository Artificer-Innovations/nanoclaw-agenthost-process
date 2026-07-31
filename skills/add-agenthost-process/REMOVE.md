# Removing `nanoclaw-agenthost-process`

## Order

1. Opt all groups off `runtime=process` (back to `docker` or another driver).
2. Uninstall **this** package from the fork.
3. Only then uninstall `nanoclaw-agenthosts` if no other agenthost plugins remain.

```bash
pnpm exec nanoclaw-agenthost-process uninstall
pnpm remove nanoclaw-agenthost-process
pnpm run build
./container/build.sh
# restart host
```

## What uninstall removes

- Copied `src/process-*.ts` files
- Boot block in `src/index.ts`
- `WORKING_ROOT` marker patches in agent-runner
- `.claude/skills/add-agenthost-process/`
- Runtime deps this package added to the fork `package.json` (at least `smol-toml`), when `src/process-runtime.ts` is gone — run `pnpm install` afterward

It does **not** remove `nanoclaw-agenthosts` or change other groups’ runtimes beyond what you configure.
