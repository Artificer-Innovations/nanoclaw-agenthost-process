import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  agenthostsInstallGuidance,
  findAgenthostsIssues,
  requireAgenthosts,
} from "./agenthosts.js";
import {
  FILE_TRANSFORMS,
  HOST_COPY_RULES,
  HOST_OPTIONAL_COPY_RULES,
  resolveCopySources,
  syncSkillToFork,
} from "./patch.js";
import {
  REQUIRED_HOST_FILES,
  findNanoclawRoot,
  readPackageVersion,
} from "./paths.js";

interface PendingWrite {
  path: string;
  content: Buffer;
  previous: Buffer | null;
  mode: number | undefined;
}

export interface InstallResult {
  root: string;
  changed: string[];
  unchanged: string[];
  version: string;
  skillPath: string;
}

export function runInstall(root?: string): InstallResult {
  const nanoclawRoot = root ?? findNanoclawRoot();
  console.log(`Detected NanoClaw root: ${nanoclawRoot}`);
  requireAgenthosts(nanoclawRoot);

  const pending: PendingWrite[] = [];
  const unchanged: string[] = [];

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Missing required host file: ${file.path}`);
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    const next = file.transform(source);
    stageIfChanged(
      pending,
      unchanged,
      absolutePath,
      file.path,
      Buffer.from(next),
    );
  }

  for (const { rule, absoluteSource } of resolveCopySources(
    nanoclawRoot,
    HOST_COPY_RULES,
  )) {
    stageIfChanged(
      pending,
      unchanged,
      path.join(nanoclawRoot, rule.dest),
      rule.dest,
      fs.readFileSync(absoluteSource),
    );
  }
  for (const { rule, absoluteSource } of resolveCopySources(
    nanoclawRoot,
    HOST_OPTIONAL_COPY_RULES,
    true,
  )) {
    stageIfChanged(
      pending,
      unchanged,
      path.join(nanoclawRoot, rule.dest),
      rule.dest,
      fs.readFileSync(absoluteSource),
    );
  }

  commitWrites(pending);
  const skillPath = syncSkillToFork(nanoclawRoot);

  return {
    root: nanoclawRoot,
    changed: pending.map((write) => path.relative(nanoclawRoot, write.path)),
    unchanged,
    version: readPackageVersion(),
    skillPath,
  };
}

export function runUpgrade(root?: string): InstallResult {
  return runInstall(root);
}

export function runVerify(root?: string): {
  root: string;
  ok: boolean;
  issues: string[];
} {
  const nanoclawRoot = root ?? findNanoclawRoot();
  const issues: string[] = findAgenthostsIssues(nanoclawRoot).map(
    (issue) => `${issue}; ${agenthostsInstallGuidance()}`,
  );

  for (const rel of REQUIRED_HOST_FILES) {
    if (!fs.existsSync(path.join(nanoclawRoot, rel))) {
      issues.push(`missing ${rel}`);
    }
  }

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) {
      issues.push(`missing ${file.path}`);
      continue;
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    if (file.verify && !file.verify(source)) {
      issues.push(`${file.path} missing agenthost-process markers`);
    }
  }

  return { root: nanoclawRoot, ok: issues.length === 0, issues };
}

export function runUninstall(root?: string): {
  root: string;
  changed: string[];
  removed: string[];
} {
  const nanoclawRoot = root ?? findNanoclawRoot();
  const pending: PendingWrite[] = [];
  const unchanged: string[] = [];

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    const next = file.uninstall(source);
    stageIfChanged(
      pending,
      unchanged,
      absolutePath,
      file.path,
      Buffer.from(next),
    );
  }
  commitWrites(pending);

  const removed: string[] = [];
  for (const rule of [...HOST_COPY_RULES, ...HOST_OPTIONAL_COPY_RULES]) {
    const target = path.join(nanoclawRoot, rule.dest);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed.push(rule.dest);
    }
  }

  const skillDest = path.join(
    nanoclawRoot,
    ".claude/skills/add-agenthost-process",
  );
  if (fs.existsSync(skillDest)) {
    fs.rmSync(skillDest, { recursive: true, force: true });
    removed.push(".claude/skills/add-agenthost-process");
  }

  return {
    root: nanoclawRoot,
    changed: pending.map((write) => path.relative(nanoclawRoot, write.path)),
    removed,
  };
}

export function printInstallNextSteps(
  result: InstallResult,
  options: { upgraded?: boolean } = {},
): void {
  console.log(
    `${options.upgraded ? "Upgraded" : "Installed"} nanoclaw-agenthost-process@${result.version} into ${result.root}`,
  );
  console.log(
    `Changed ${result.changed.length} files; ${result.unchanged.length} already current.`,
  );
  console.log(`Synced skill → ${result.skillPath}`);
  console.log("\nNext steps:");
  console.log("  1. pnpm run build");
  console.log(
    "  2. ./container/build.sh   # WORKING_ROOT patches live in the agent-runner image",
  );
  console.log("  3. pnpm exec nanoclaw-agenthost-process verify");
  console.log(
    "  4. Opt a group in: ncl groups config update --id <id> --runtime process",
  );
  console.log("  5. Restart the NanoClaw host service");
  console.log(
    "\nSecurity: process mode runs agents as the host user — prefer Docker for untrusted content.",
  );
}

function stageIfChanged(
  pending: PendingWrite[],
  unchanged: string[],
  absolutePath: string,
  relativePath: string,
  content: Buffer,
): void {
  const exists = fs.existsSync(absolutePath);
  const previous = exists ? fs.readFileSync(absolutePath) : null;
  if (previous?.equals(content)) {
    unchanged.push(relativePath);
    return;
  }
  pending.push({
    path: absolutePath,
    content,
    previous,
    mode: exists ? fs.statSync(absolutePath).mode : undefined,
  });
}

function commitWrites(writes: PendingWrite[]): void {
  const committed: PendingWrite[] = [];
  try {
    for (const write of writes) {
      atomicWrite(write.path, write.content, write.mode);
      committed.push(write);
    }
  } catch (error) {
    for (const write of committed.reverse()) {
      if (write.previous === null) fs.rmSync(write.path, { force: true });
      else atomicWrite(write.path, write.previous, write.mode);
    }
    throw error;
  }
}

function atomicWrite(target: string, content: Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.agenthost-process-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      content,
      mode === undefined ? undefined : { mode },
    );
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
