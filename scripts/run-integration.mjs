#!/usr/bin/env node
/**
 * Fixture install → verify → uninstall smoke (stock NanoClaw anchors).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binUrl = pathToFileURL(path.join(root, "dist/cli/bin.js")).href;

if (!fs.existsSync(path.join(root, "dist/cli/bin.js"))) {
  console.error("Missing dist/cli/bin.js — run pnpm run build first");
  process.exit(1);
}

const { runInstall, runUninstall, runVerify } = await import(
  binUrl.replace(/bin\.js$/, "install.js")
);

const EXPECTED_AGENTHOSTS_API_VERSION = 1;

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ahp-integration-"));
const files = {
  "src/agenthosts.ts": `export const AGENTHOSTS_API_VERSION = ${EXPECTED_AGENTHOSTS_API_VERSION} as const;
export function registerRuntimeDriver() {}
export function resolveRuntimeDriver() {}
`,
  "src/container-runner.ts": `// @nanoclaw-agenthosts:wake-rename:begin
// wakeContainer → wakeContainerDocker
// @nanoclaw-agenthosts:wake-rename:end
// @nanoclaw-agenthosts:kill-rename:begin
// killContainer → killContainerDocker
// @nanoclaw-agenthosts:kill-rename:end
// @nanoclaw-agenthosts:is-running-rename:begin
// isContainerRunning → isContainerRunningDocker
// @nanoclaw-agenthosts:is-running-rename:end
// @nanoclaw-agenthosts:public-exports:begin
export function wakeContainer(session) { return resolveRuntimeDriver(session).wake(session, {}); }
// @nanoclaw-agenthosts:public-exports:end
`,
  "src/index.ts": `async function main() {
  await startCliServer();
  await initChannelAdapters();
}
`,
  "src/channels/index.ts": "export {};\n",
  "container/agent-runner/src/db/connection.ts": `const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';
`,
  "container/agent-runner/src/index.ts": `const CWD = '/workspace/agent';
ensureMemoryScaffold();
`,
  "container/agent-runner/src/config.ts": `const CONFIG_PATH = '/workspace/agent/container.json';
`,
  "package.json": JSON.stringify({ name: "nanoclaw-fixture" }),
};

try {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(fixture, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  runInstall(fixture);
  const verify = runVerify(fixture);
  if (!verify.ok) {
    console.error(verify.issues);
    process.exit(1);
  }
  runUninstall(fixture);
  console.log("Integration OK");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
