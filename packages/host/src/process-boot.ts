import { registerRuntimeDriver } from "./agenthosts.js";
import { readEnvFile } from "./env.js";
import { log } from "./log.js";
import { applyProcessHostEnvFromFile } from "./process-env.js";
import { isProcessRuntimeAllowed, processDriver } from "./process-runtime.js";

/**
 * Apply .env NANOCLAW_ALLOW_PROCESS_RUNTIME into process.env when unset
 * (NanoClaw does not dotenv-load; LaunchAgents often omit this key).
 */
function applyProcessHostEnv(): void {
  applyProcessHostEnvFromFile(process.env, (keys) => readEnvFile(keys));
}

/**
 * Register the local process RuntimeDriver with nanoclaw-agenthosts.
 * Idempotent — safe to call on every host boot.
 *
 * Wakes still require `NANOCLAW_ALLOW_PROCESS_RUNTIME=1` so a per-group
 * `--runtime process` flag alone cannot remove the sandbox.
 */
export function startAgenthostProcess(): void {
  try {
    applyProcessHostEnv();
  } catch (err) {
    // Malformed/unreadable .env must not skip driver registration — wakes still
    // fail closed without the allow flag; an explicit process.env value still wins.
    log.warn(
      "Failed to apply NANOCLAW_ALLOW_PROCESS_RUNTIME from .env — continuing with process.env only",
      { err },
    );
  }
  registerRuntimeDriver("process", processDriver);
  if (!isProcessRuntimeAllowed()) {
    log.warn(
      "Registered RuntimeDriver: process — wakes fail closed until NANOCLAW_ALLOW_PROCESS_RUNTIME=1 (set in host env or .env)",
    );
    return;
  }
  log.info("Registered RuntimeDriver: process");
}
