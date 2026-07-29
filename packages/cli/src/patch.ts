import fs from "node:fs";
import path from "node:path";
import {
  HOST_COPY_RULES,
  HOST_OPTIONAL_COPY_RULES,
  PROCESS_BOOT_BLOCK,
  PROCESS_MARKER,
  WORKING_ROOT_CONFIG_PATH,
  WORKING_ROOT_CONNECTION_PATH,
  WORKING_ROOT_INDEX_PATH,
  resourcesDir,
  skillDir,
  type CopyRule,
} from "./paths.js";

const BOOT_BEGIN = `// ${PROCESS_MARKER}:boot:begin`;
const BOOT_END = `// ${PROCESS_MARKER}:boot:end`;

const PATHS_BEGIN = `// ${PROCESS_MARKER}:working-root-paths:begin`;
const PATHS_END = `// ${PROCESS_MARKER}:working-root-paths:end`;

const CWD_BEGIN = `// ${PROCESS_MARKER}:working-root-cwd:begin`;
const CWD_END = `// ${PROCESS_MARKER}:working-root-cwd:end`;

const CONFIG_BEGIN = `// ${PROCESS_MARKER}:working-root-config:begin`;
const CONFIG_END = `// ${PROCESS_MARKER}:working-root-config:end`;

const WORKING_ROOT_PATHS_BLOCK = `${PATHS_BEGIN}
const WORKING_ROOT = process.env.WORKING_ROOT || '/workspace';
const DEFAULT_INBOUND_PATH = \`\${WORKING_ROOT}/inbound.db\`;
const DEFAULT_OUTBOUND_PATH = \`\${WORKING_ROOT}/outbound.db\`;
const DEFAULT_HEARTBEAT_PATH = \`\${WORKING_ROOT}/.heartbeat\`;
${PATHS_END}`;

const WORKING_ROOT_CWD_BLOCK = `${CWD_BEGIN}
const CWD = process.env.WORKING_ROOT
  ? \`\${process.env.WORKING_ROOT}/agent\`
  : '/workspace/agent';
${CWD_END}`;

const WORKING_ROOT_CONFIG_BLOCK = `${CONFIG_BEGIN}
const CONFIG_PATH = process.env.WORKING_ROOT
  ? \`\${process.env.WORKING_ROOT}/agent/container.json\`
  : '/workspace/agent/container.json';
${CONFIG_END}`;

export function hasProcessBootBlock(content: string): boolean {
  return (
    content.includes(BOOT_BEGIN) && content.includes("startAgenthostProcess")
  );
}

export function findProcessBootInsertIndex(content: string): number {
  const afterAdmin = content.match(/^[ \t]*await startAdminApi\(\);\r?\n/m);
  if (afterAdmin?.index != null) return afterAdmin.index + afterAdmin[0].length;

  const afterCli = content.match(/^[ \t]*await startCliServer\(\);\r?\n/m);
  if (afterCli?.index != null) return afterCli.index + afterCli[0].length;

  const afterAgenthosts = content.match(
    /^[ \t]*\/\/ @nanoclaw-agenthosts:boot:end\r?\n/m,
  );
  if (afterAgenthosts?.index != null) {
    return afterAgenthosts.index + afterAgenthosts[0].length;
  }

  const awaited = content.match(/^\s+await initChannelAdapters\(/m);
  if (awaited?.index != null) return awaited.index;

  const plain = content.match(/^\s+initChannelAdapters\(/m);
  if (plain?.index != null) return plain.index;

  return -1;
}

export function insertProcessBootBlockContent(content: string): string {
  if (hasProcessBootBlock(content)) return content;
  const idx = findProcessBootInsertIndex(content);
  if (idx < 0) {
    throw new Error("Could not find boot insert point in src/index.ts");
  }
  return `${content.slice(0, idx)}\n${PROCESS_BOOT_BLOCK}\n${content.slice(idx)}`;
}

export function removeProcessBootBlockContent(content: string): string {
  const pattern =
    /\r?\n?[ \t]*\/\/ @nanoclaw-agenthost-process:boot:begin\r?\n[\s\S]*?[ \t]*\/\/ @nanoclaw-agenthost-process:boot:end\r?\n?/;
  return content.replace(pattern, "\n");
}

const LEGACY_PATH_CONSTS =
  /const DEFAULT_INBOUND_PATH = '\/workspace\/inbound\.db';\r?\nconst DEFAULT_OUTBOUND_PATH = '\/workspace\/outbound\.db';\r?\nconst DEFAULT_HEARTBEAT_PATH = '\/workspace\/\.heartbeat';/;

export function patchWorkingRootPaths(content: string): string {
  if (content.includes(PATHS_BEGIN)) return content;
  if (!LEGACY_PATH_CONSTS.test(content)) {
    throw new Error(
      `${WORKING_ROOT_CONNECTION_PATH} missing expected /workspace DEFAULT_* path constants (anchors moved?)`,
    );
  }
  return content.replace(LEGACY_PATH_CONSTS, WORKING_ROOT_PATHS_BLOCK);
}

export function unpatchWorkingRootPaths(content: string): string {
  if (!content.includes(PATHS_BEGIN)) return content;
  const pattern = new RegExp(
    `${escapeRegExp(PATHS_BEGIN)}[\\s\\S]*?${escapeRegExp(PATHS_END)}`,
  );
  return content.replace(
    pattern,
    `const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';\nconst DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';\nconst DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';`,
  );
}

const LEGACY_CWD = /const CWD = '\/workspace\/agent';/;

export function patchWorkingRootCwd(content: string): string {
  let next = content;
  if (!next.includes(CWD_BEGIN)) {
    if (!LEGACY_CWD.test(next)) {
      throw new Error(
        `${WORKING_ROOT_INDEX_PATH} missing expected const CWD = '/workspace/agent' (anchors moved?)`,
      );
    }
    next = next.replace(LEGACY_CWD, WORKING_ROOT_CWD_BLOCK);
  }
  // Docker default is /workspace/agent; process mode needs the resolved CWD.
  if (next.includes("ensureMemoryScaffold();")) {
    next = next.replace("ensureMemoryScaffold();", "ensureMemoryScaffold(CWD);");
  }
  return next;
}

export function unpatchWorkingRootCwd(content: string): string {
  let next = content;
  if (next.includes(CWD_BEGIN)) {
    const pattern = new RegExp(
      `${escapeRegExp(CWD_BEGIN)}[\\s\\S]*?${escapeRegExp(CWD_END)}`,
    );
    next = next.replace(pattern, `const CWD = '/workspace/agent';`);
  }
  if (next.includes("ensureMemoryScaffold(CWD);")) {
    next = next.replace("ensureMemoryScaffold(CWD);", "ensureMemoryScaffold();");
  }
  return next;
}

const LEGACY_CONFIG_PATH =
  /const CONFIG_PATH = '\/workspace\/agent\/container\.json';/;

export function patchWorkingRootConfig(content: string): string {
  if (content.includes(CONFIG_BEGIN)) return content;
  if (!LEGACY_CONFIG_PATH.test(content)) {
    throw new Error(
      `${WORKING_ROOT_CONFIG_PATH} missing expected CONFIG_PATH = '/workspace/agent/container.json' (anchors moved?)`,
    );
  }
  return content.replace(LEGACY_CONFIG_PATH, WORKING_ROOT_CONFIG_BLOCK);
}

export function unpatchWorkingRootConfig(content: string): string {
  if (!content.includes(CONFIG_BEGIN)) return content;
  const pattern = new RegExp(
    `${escapeRegExp(CONFIG_BEGIN)}[\\s\\S]*?${escapeRegExp(CONFIG_END)}`,
  );
  return content.replace(
    pattern,
    `const CONFIG_PATH = '/workspace/agent/container.json';`,
  );
}

export function hasWorkingRootPaths(content: string): boolean {
  return content.includes(PATHS_BEGIN) && content.includes("WORKING_ROOT");
}

export function hasWorkingRootCwd(content: string): boolean {
  return (
    content.includes(CWD_BEGIN) &&
    content.includes("WORKING_ROOT") &&
    content.includes("ensureMemoryScaffold(CWD)")
  );
}

export function hasWorkingRootConfig(content: string): boolean {
  return content.includes(CONFIG_BEGIN) && content.includes("WORKING_ROOT");
}

export interface FileTransform {
  path: string;
  transform: (source: string) => string;
  uninstall: (source: string) => string;
  verify?: (source: string) => boolean;
}

export const FILE_TRANSFORMS: FileTransform[] = [
  {
    path: "src/index.ts",
    transform: insertProcessBootBlockContent,
    uninstall: removeProcessBootBlockContent,
    verify: hasProcessBootBlock,
  },
  {
    path: WORKING_ROOT_CONNECTION_PATH,
    transform: patchWorkingRootPaths,
    uninstall: unpatchWorkingRootPaths,
    verify: hasWorkingRootPaths,
  },
  {
    path: WORKING_ROOT_INDEX_PATH,
    transform: patchWorkingRootCwd,
    uninstall: unpatchWorkingRootCwd,
    verify: hasWorkingRootCwd,
  },
  {
    path: WORKING_ROOT_CONFIG_PATH,
    transform: patchWorkingRootConfig,
    uninstall: unpatchWorkingRootConfig,
    verify: hasWorkingRootConfig,
  },
];

export function syncSkillToFork(
  nanoclawRoot: string,
  source: string = skillDir(),
): string {
  const destination = path.join(
    nanoclawRoot,
    ".claude/skills/add-agenthost-process",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  copyDirectory(source, destination);
  return destination;
}

export function resolveCopySources(
  nanoclawRoot: string,
  rules: CopyRule[],
  optional = false,
): { rule: CopyRule; absoluteSource: string }[] {
  const resources = resourcesDir(undefined, nanoclawRoot);
  const resolved: { rule: CopyRule; absoluteSource: string }[] = [];
  for (const rule of rules) {
    const absoluteSource = path.join(resources, rule.source);
    if (!fs.existsSync(absoluteSource)) {
      if (optional) continue;
      throw new Error(
        `Missing bundled resource: ${rule.source}. Run pnpm run build.`,
      );
    }
    resolved.push({ rule, absoluteSource });
  }
  return resolved;
}

export { HOST_COPY_RULES, HOST_OPTIONAL_COPY_RULES };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function copyDirectory(source: string, destination: string): void {
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory())
    fs.rmSync(destination, { force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(destination)) {
    fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}
