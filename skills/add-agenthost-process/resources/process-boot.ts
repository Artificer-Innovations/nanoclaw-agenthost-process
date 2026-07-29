import { registerRuntimeDriver } from "./agenthosts.js";
import { log } from "./log.js";
import { isProcessRuntimeAllowed, processDriver } from "./process-runtime.js";

/**
 * Register the local process RuntimeDriver with nanoclaw-agenthosts.
 * Idempotent — safe to call on every host boot.
 *
 * Wakes still require `NANOCLAW_ALLOW_PROCESS_RUNTIME=1` so a per-group
 * `--runtime process` flag alone cannot remove the sandbox.
 */
export function startAgenthostProcess(): void {
  registerRuntimeDriver("process", processDriver);
  if (!isProcessRuntimeAllowed()) {
    log.warn(
      "Registered RuntimeDriver: process — wakes fail closed until NANOCLAW_ALLOW_PROCESS_RUNTIME=1",
    );
    return;
  }
  log.info("Registered RuntimeDriver: process");
}
