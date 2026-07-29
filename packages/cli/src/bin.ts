#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  printInstallNextSteps,
  runInstall,
  runUninstall,
  runUpgrade,
  runVerify,
} from "./install.js";
import { syncSkillToFork } from "./patch.js";
import { findNanoclawRoot } from "./paths.js";

function parseArgs(argv: string[]): { command: string; path?: string } {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  let pathArg: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--path" && args[i + 1]) {
      pathArg = args[i + 1];
      i += 1;
    }
  }
  return { command, path: pathArg };
}

export function runCommand(argv: string[]): number {
  const { command, path: pathArg } = parseArgs(argv);

  try {
    switch (command) {
      case "install": {
        const result = runInstall(pathArg);
        printInstallNextSteps(result);
        return 0;
      }
      case "upgrade": {
        const result = runUpgrade(pathArg);
        printInstallNextSteps(result, { upgraded: true });
        return 0;
      }
      case "sync-skill": {
        const root = pathArg ?? findNanoclawRoot();
        const dest = syncSkillToFork(root);
        console.log(`Synced skill → ${dest}`);
        return 0;
      }
      case "verify": {
        const result = runVerify(pathArg);
        if (!result.ok) {
          console.error("Verification failed:");
          for (const issue of result.issues) console.error(`  - ${issue}`);
          return 1;
        }
        console.log(`Verification passed for ${result.root}`);
        return 0;
      }
      case "uninstall": {
        const result = runUninstall(pathArg);
        console.log(`Removed agenthost-process from ${result.root}`);
        console.log(
          `Changed ${result.changed.length} files; deleted ${result.removed.length} files.`,
        );
        console.log(
          "\nSee .claude/skills/add-agenthost-process/REMOVE.md if present.",
        );
        console.log("Optional: pnpm remove nanoclaw-agenthost-process");
        console.log(
          "Then: pnpm run build && ./container/build.sh && restart host",
        );
        return 0;
      }
      default:
        console.log(`Usage: nanoclaw-agenthost-process <command> [--path <nanoclaw-root>]

Commands:
  install      Require agenthosts, copy driver files, patch boot + WORKING_ROOT
  upgrade      Re-copy + re-patch (idempotent install)
  sync-skill   Copy bundled skill to .claude/skills/add-agenthost-process/
  verify       Check agenthosts peer, files, and markers
  uninstall    Remove files, boot block, and WORKING_ROOT patches
`);
        return command === "help" ? 0 : 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

export { parseArgs };

export function isCliEntry(entryPath: string, argv: string[]): boolean {
  if (!argv[1]) return false;
  try {
    return realpathSync(entryPath) === realpathSync(path.resolve(argv[1]));
  } catch {
    return entryPath === argv[1];
  }
}

function main(): void {
  process.exit(runCommand(process.argv));
}

export { main };

/* v8 ignore start */
if (isCliEntry(fileURLToPath(import.meta.url), process.argv)) {
  main();
}
/* v8 ignore stop */
