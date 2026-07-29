#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const bin = path.join(root, "dist/cli/bin.js");

if (!fs.existsSync(bin)) {
  console.error("Missing dist/cli/bin.js — CLI build failed");
  process.exit(1);
}

const resourcesDir = path.join(root, "skills/add-agenthost-process/resources");
for (const required of [
  "process-boot.ts",
  "process-runtime.ts",
  "process-onecli.ts",
]) {
  const file = path.join(resourcesDir, required);
  if (!fs.existsSync(file)) {
    console.error(`Missing skill resource ${required} — run sync-resources`);
    process.exit(1);
  }
}

console.log("Publish entry OK");
