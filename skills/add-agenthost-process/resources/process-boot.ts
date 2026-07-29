import { registerRuntimeDriver } from "./agenthosts.js";
import { log } from "./log.js";
import { processDriver } from "./process-runtime.js";

/**
 * Register the local process RuntimeDriver with nanoclaw-agenthosts.
 * Idempotent — safe to call on every host boot.
 */
export function startAgenthostProcess(): void {
  registerRuntimeDriver("process", processDriver);
  log.info("Registered RuntimeDriver: process");
}
