#!/usr/bin/env node
/**
 * Sync packages/host/src → skills/add-agenthost-process/resources
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const hostSrc = path.join(root, "packages/host/src");
const destHost = path.join(root, "skills/add-agenthost-process/resources");

fs.mkdirSync(destHost, { recursive: true });
for (const name of fs.readdirSync(destHost)) {
  fs.rmSync(path.join(destHost, name), { recursive: true, force: true });
}
for (const name of fs.readdirSync(hostSrc)) {
  if (!name.endsWith(".ts")) continue;
  fs.copyFileSync(path.join(hostSrc, name), path.join(destHost, name));
}

console.log(`Synced host sources → ${path.relative(root, destHost)}`);
