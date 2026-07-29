/** CI-only stub — real module exists once installed into a NanoClaw host. */
import path from "node:path";
import { DATA_DIR } from "./config.js";

export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, "v2-sessions", agentGroupId, sessionId);
}

export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), ".heartbeat");
}

export function markContainerRunning(_sessionId: string): void {}
export function markContainerStopped(_sessionId: string): void {}
