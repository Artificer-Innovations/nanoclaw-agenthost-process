# API contract — nanoclaw-agenthost-process

**Package API version:** aligns with `nanoclaw-agenthosts` **API v1**.

## Peer: nanoclaw-agenthosts

This package **registers** a driver; it does not own wake/kill call-site patches.

Expected host symbols after `nanoclaw-agenthosts install`:

```ts
export const AGENTHOSTS_API_VERSION = 1 as const;

registerRuntimeDriver(name: string, driver: RuntimeDriver): () => void;
resolveRuntimeDriver(session: SessionRef): RuntimeDriver;

interface RuntimeDriver {
  wake(session: SessionRef, ctx: WakeContext): Promise<boolean>;
  kill(sessionId: string, reason: string, onExit?: () => void): void;
  isRunning(sessionId: string): boolean;
  cleanupOrphans?(): void | Promise<void>;
  buildImage?(agentGroupId: string, opts?: unknown): Promise<void>;
  requiredTransport?: string | string[];
}
```

Installer peer checks also require these markers in `src/container-runner.ts`:

- `@nanoclaw-agenthosts:wake-rename:begin`
- `@nanoclaw-agenthosts:kill-rename:begin`
- `@nanoclaw-agenthosts:is-running-rename:begin`
- `@nanoclaw-agenthosts:public-exports:begin`
- `resolveRuntimeDriver`

## Registration

```ts
// src/process-boot.ts (copied into the fork)
import { registerRuntimeDriver } from "./agenthosts.js";
import { processDriver } from "./process-runtime.js";

export function startAgenthostProcess() {
  registerRuntimeDriver("process", processDriver);
}
```

Driver name: **`process`**. `requiredTransport` is unset (filesystem mailbox OK).

## Host opt-in

`NANOCLAW_ALLOW_PROCESS_RUNTIME=1` (or `true` / `yes`) must be set on the host process — via NanoClaw `.env` (process boot applies it when unset) or LaunchAgent / shell env. Without it, `wake` fails closed even when a group has `runtime=process`. Prefer `.env` with mode `0600` / owner-only and gitignored; an already-set `process.env` value wins over `.env`.

After `WAKE_FAIL_BLOCK_AFTER` (5) consecutive fail-closed wakes for a session, the driver writes `WORKING_ROOT/.process.wake-blocked` and logs an error.

## Process Codex `config.toml`

On wake, the process driver ensures per-group `CODEX_HOME/config.toml` forces file-backed credential stores and `[features].secret_auth_storage = false`. The file is **host-normalized** (structured TOML rewrite — comments/ordering may change). In-process locking serializes concurrent wakes for the same `codexHome`; cross-host multi-writer locking is out of scope for 0.1.0.

## WakeContext (consumed fields)

agenthosts v1 calls `wake(session, {})`. The process driver resolves paths from NanoClaw host modules when context fields are absent. Optional overrides:

| Field                                               | Purpose                                  |
| --------------------------------------------------- | ---------------------------------------- |
| `sessionDir`                                        | Absolute session folder → `WORKING_ROOT` |
| `groupDir`                                          | Absolute agent group folder              |
| `agentRunnerEntry`                                  | Absolute path to agent-runner entry      |
| `agentGroupName` / `agentIdentifier`                | OneCLI ensureAgent                       |
| `bunBinary?`                                        | Override spawn binary                    |
| `env?`                                              | Extra child env                          |
| `clearHeartbeat?` / `markRunning?` / `markStopped?` | Host lifecycle hooks                     |

When omitted, the driver uses `getAgentGroup`, `sessionDir()`, `GROUPS_DIR`, and `container/agent-runner/src/index.ts` under `process.cwd()`.

## WORKING_ROOT

Installer patches agent-runner so DB/heartbeat/CWD honor `process.env.WORKING_ROOT`, defaulting to `/workspace` when unset (Docker unchanged).

## Semver

- Patch: bugfixes in spawn/kill/installer without contract changes
- Minor: new optional WakeContext fields, additive env
- Major: driver name change, required peer API bump, breaking marker renames
