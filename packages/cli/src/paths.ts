import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function packageRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        name?: string;
      };
      if (pkg.name === "nanoclaw-agenthost-process") return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate nanoclaw-agenthost-process package root");
}

export function skillDir(startDir: string = __dirname): string {
  return path.join(packageRoot(startDir), "skills/add-agenthost-process");
}

export function hostSrcDir(startDir: string = __dirname): string {
  return path.join(packageRoot(startDir), "packages/host/src");
}

export function resourcesDir(
  startDir: string = __dirname,
  nanoclawRoot?: string,
): string {
  const hostSrc = hostSrcDir(startDir);
  if (fs.existsSync(path.join(hostSrc, "process-boot.ts"))) {
    return hostSrc;
  }
  if (nanoclawRoot) {
    const linked = resolveLinkedHostSrc(nanoclawRoot);
    if (linked) return linked;
  }
  return path.join(skillDir(startDir), "resources");
}

function resolveLinkedRoot(nanoclawRoot: string): string | null {
  const pkgPath = path.join(nanoclawRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dep =
    pkg.dependencies?.["nanoclaw-agenthost-process"] ??
    pkg.devDependencies?.["nanoclaw-agenthost-process"];
  if (!dep?.startsWith("file:")) return null;
  return path.resolve(nanoclawRoot, dep.slice("file:".length));
}

function resolveLinkedHostSrc(nanoclawRoot: string): string | null {
  const linkedRoot = resolveLinkedRoot(nanoclawRoot);
  if (!linkedRoot) return null;
  const hostSrc = path.join(linkedRoot, "packages/host/src");
  return fs.existsSync(path.join(hostSrc, "process-boot.ts")) ? hostSrc : null;
}

export interface CopyRule {
  source: string;
  dest: string;
}

export const HOST_COPY_RULES: CopyRule[] = [
  { source: "process-boot.ts", dest: "src/process-boot.ts" },
  { source: "process-runtime.ts", dest: "src/process-runtime.ts" },
  { source: "process-onecli.ts", dest: "src/process-onecli.ts" },
];

export const HOST_OPTIONAL_COPY_RULES: CopyRule[] = [
  { source: "process-boot.test.ts", dest: "src/process-boot.test.ts" },
  { source: "process-runtime.test.ts", dest: "src/process-runtime.test.ts" },
  { source: "process-onecli.test.ts", dest: "src/process-onecli.test.ts" },
  { source: "process-wiring.test.ts", dest: "src/process-wiring.test.ts" },
];

export const PROCESS_BOOT_BLOCK = `  // @nanoclaw-agenthost-process:boot:begin
  const { startAgenthostProcess } = await import('./process-boot.js');
  startAgenthostProcess();
  // @nanoclaw-agenthost-process:boot:end`;

export const PROCESS_MARKER = "@nanoclaw-agenthost-process";

export const REQUIRED_HOST_FILES = HOST_COPY_RULES.map((r) => r.dest);

export const WORKING_ROOT_CONNECTION_PATH =
  "container/agent-runner/src/db/connection.ts";
export const WORKING_ROOT_INDEX_PATH = "container/agent-runner/src/index.ts";
export const WORKING_ROOT_CONFIG_PATH = "container/agent-runner/src/config.ts";

export function findNanoclawRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    const channelsIndex = path.join(dir, "src/channels/index.ts");
    const hostIndex = path.join(dir, "src/index.ts");
    if (fs.existsSync(channelsIndex) && fs.existsSync(hostIndex)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "NanoClaw root not found (expected src/channels/index.ts and src/index.ts). Use --path.",
  );
}

export function readPackageVersion(): string {
  const pkgPath = path.join(packageRoot(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}
