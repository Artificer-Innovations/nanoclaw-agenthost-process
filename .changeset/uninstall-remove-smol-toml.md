---
"nanoclaw-agenthost-process": patch
---

Remove `smol-toml` (and other consumer runtime deps this package added) from the fork `package.json` on uninstall once `src/process-runtime.ts` is gone.
