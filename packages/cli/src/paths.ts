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
  { source: "process-env.ts", dest: "src/process-env.ts" },
  { source: "process-runtime.ts", dest: "src/process-runtime.ts" },
  { source: "process-onecli.ts", dest: "src/process-onecli.ts" },
];

export const HOST_OPTIONAL_COPY_RULES: CopyRule[] = [
  { source: "process-boot.test.ts", dest: "src/process-boot.test.ts" },
  { source: "process-env.test.ts", dest: "src/process-env.test.ts" },
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

/**
 * Runtime deps that copied host sources import (e.g. smol-toml from
 * process-runtime.ts). Install must pin these on the consumer package.json —
 * copying the file alone leaves the fork unable to resolve the module.
 */
export function consumerRuntimeDependencies(
  startDir: string = __dirname,
): Record<string, string> {
  const hostPkgPath = path.join(
    packageRoot(startDir),
    "packages/host/package.json",
  );
  if (!fs.existsSync(hostPkgPath)) {
    // Published layout: host package.json may be absent; fall back to skill
    // resources sibling metadata is not available — use the known pin.
    return { "smol-toml": "^1.7.1" };
  }
  const hostPkg = JSON.parse(fs.readFileSync(hostPkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const out: Record<string, string> = {};
  const range = hostPkg.dependencies?.["smol-toml"];
  if (range) out["smol-toml"] = range;
  return out;
}

export function findMissingConsumerRuntimeDependencies(
  nanoclawRoot: string,
  startDir: string = __dirname,
): string[] {
  const required = consumerRuntimeDependencies(startDir);
  const pkgPath = path.join(nanoclawRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return Object.keys(required).map(
      (name) => `missing dependency ${name} in package.json`,
    );
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const missing: string[] = [];
  for (const name of Object.keys(required)) {
    if (!pkg.dependencies?.[name] && !pkg.devDependencies?.[name]) {
      missing.push(
        `missing dependency ${name} in package.json (required by process-runtime.ts)`,
      );
    }
  }
  return missing;
}

/** Ensure consumer package.json lists runtime deps imported by copied host sources. */
export function ensureConsumerRuntimeDependencies(
  nanoclawRoot: string,
  startDir: string = __dirname,
): { changed: boolean; added: string[] } {
  const required = consumerRuntimeDependencies(startDir);
  const pkgPath = path.join(nanoclawRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Missing package.json at ${pkgPath}`);
  }
  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  const dependencies = { ...(pkg.dependencies ?? {}) };
  const added: string[] = [];
  for (const [name, range] of Object.entries(required)) {
    if (!dependencies[name]) {
      dependencies[name] = range;
      added.push(name);
    }
  }
  if (!added.length) return { changed: false, added: [] };
  pkg.dependencies = dependencies;
  const next = `${JSON.stringify(pkg, null, 2)}\n`;
  fs.writeFileSync(pkgPath, next);
  return { changed: true, added };
}

const CONSUMER_SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

/**
 * True when some consumer source other than process-runtime.ts still imports
 * `name` — uninstall must leave those pins alone.
 */
function consumerImportsDependency(
  nanoclawRoot: string,
  name: string,
): boolean {
  const srcRoot = path.join(nanoclawRoot, "src");
  if (!fs.existsSync(srcRoot)) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Static ESM, CJS require(), and dynamic import() — any of these means the
  // fork still uses the dep and uninstall must leave the pin alone.
  const needle = new RegExp(
    `(?:from\\s+['"]${escaped}['"]|require\\(\\s*['"]${escaped}['"]\\s*\\)|import\\(\\s*['"]${escaped}['"]\\s*\\))`,
  );
  const walk = (dir: string): boolean => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
        continue;
      }
      // TS + JS under src/ (compiled or hand-written CJS).
      if (!CONSUMER_SOURCE_EXTS.has(path.extname(entry.name))) continue;
      let text: string;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (needle.test(text)) return true;
    }
    return false;
  };
  return walk(srcRoot);
}

/**
 * Drop runtime deps that were only needed for copied host sources.
 * Only removes when:
 * - process-runtime.ts is gone (the importer we installed)
 * - the pin's version range matches what this package would have added
 * - no other consumer source still imports the package
 */
export function removeConsumerRuntimeDependencies(
  nanoclawRoot: string,
  startDir: string = __dirname,
): { changed: boolean; removed: string[] } {
  const required = consumerRuntimeDependencies(startDir);
  const candidates = Object.entries(required);
  if (!candidates.length) return { changed: false, removed: [] };

  const processRuntime = path.join(nanoclawRoot, "src/process-runtime.ts");
  if (fs.existsSync(processRuntime)) {
    return { changed: false, removed: [] };
  }

  const pkgPath = path.join(nanoclawRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return { changed: false, removed: [] };

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
  };

  const removed: string[] = [];
  for (const [name, expectedRange] of candidates) {
    if (consumerImportsDependency(nanoclawRoot, name)) continue;

    if (pkg.dependencies?.[name] === expectedRange) {
      delete pkg.dependencies[name];
      removed.push(name);
    }
    if (pkg.devDependencies?.[name] === expectedRange) {
      delete pkg.devDependencies[name];
      if (!removed.includes(name)) removed.push(name);
    }
  }
  if (!removed.length) return { changed: false, removed: [] };

  if (pkg.dependencies && Object.keys(pkg.dependencies).length === 0) {
    delete pkg.dependencies;
  }
  if (pkg.devDependencies && Object.keys(pkg.devDependencies).length === 0) {
    delete pkg.devDependencies;
  }

  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return { changed: true, removed };
}
