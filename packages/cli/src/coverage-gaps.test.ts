import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPECTED_AGENTHOSTS_API_VERSION,
  agenthostsInstallGuidance,
  findAgenthostsIssues,
} from "./agenthosts.js";
import { runCommand } from "./bin.js";
import { agenthostsOk, writeFixture } from "./agenthosts.test.js";
import {
  findProcessBootInsertIndex,
  insertProcessBootBlockContent,
  resolveCopySources,
  syncSkillToFork,
} from "./patch.js";
import {
  HOST_OPTIONAL_COPY_RULES,
  packageRoot,
  resourcesDir,
} from "./paths.js";
import { runInstall, runUninstall, runVerify } from "./install.js";

describe("agenthosts partial tokens", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports missing tokens inside existing files", () => {
    root = mkdtempSync(path.join(tmpdir(), "ah-partial-"));
    writeFixture(
      root,
      "src/agenthosts.ts",
      `export const AGENTHOSTS_API_VERSION = ${EXPECTED_AGENTHOSTS_API_VERSION} as const;\n`,
    );
    writeFixture(root, "src/container-runner.ts", "// empty\n");
    const issues = findAgenthostsIssues(root);
    expect(issues.some((i) => i.includes("registerRuntimeDriver"))).toBe(true);
    expect(issues.some((i) => i.includes("wake-rename:begin"))).toBe(true);
    expect(agenthostsInstallGuidance()).toContain("nanoclaw-agenthosts");
  });
});

describe("bin commands against fixture", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function seed(): void {
    root = mkdtempSync(path.join(tmpdir(), "ahp-bin-"));
    agenthostsOk(root);
    writeFixture(
      root,
      "src/index.ts",
      `async function main() {\n  await startAdminApi();\n  initChannelAdapters();\n}\n`,
    );
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(
      root,
      "container/agent-runner/src/db/connection.ts",
      `const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';
`,
    );
    writeFixture(
      root,
      "container/agent-runner/src/index.ts",
      `const CWD = '/workspace/agent';\nensureMemoryScaffold();\n`,
    );
    writeFixture(
      root,
      "container/agent-runner/src/config.ts",
      `const CONFIG_PATH = '/workspace/agent/container.json';\n`,
    );
    writeFixture(root, "package.json", "{}");
  }

  it("install / verify / sync-skill / uninstall via runCommand", () => {
    seed();
    expect(runCommand(["node", "bin.js", "install", "--path", root])).toBe(0);
    expect(runCommand(["node", "bin.js", "verify", "--path", root])).toBe(0);
    expect(runCommand(["node", "bin.js", "sync-skill", "--path", root])).toBe(
      0,
    );
    expect(runCommand(["node", "bin.js", "uninstall", "--path", root])).toBe(0);
  });

  it("verify returns 1 on failure", () => {
    seed();
    expect(runCommand(["node", "bin.js", "verify", "--path", root])).toBe(1);
  });

  it("install returns 1 when agenthosts missing", () => {
    seed();
    rmSync(path.join(root, "src/agenthosts.ts"));
    expect(runCommand(["node", "bin.js", "install", "--path", root])).toBe(1);
  });
});

describe("patch edge cases", () => {
  it("inserts after agenthosts boot end marker", () => {
    const source = `  // @nanoclaw-agenthosts:boot:end\n  await initChannelAdapters();\n`;
    expect(findProcessBootInsertIndex(source)).toBeGreaterThan(0);
    expect(insertProcessBootBlockContent(source)).toContain(
      "startAgenthostProcess",
    );
  });

  it("resolveCopySources skips optional missing files", () => {
    const root = packageRoot();
    const resolved = resolveCopySources(root, HOST_OPTIONAL_COPY_RULES, true);
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("syncSkillToFork copies skill", () => {
    const destRoot = mkdtempSync(path.join(tmpdir(), "skill-sync-"));
    try {
      const dest = syncSkillToFork(destRoot);
      expect(existsSync(path.join(dest, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(destRoot, { recursive: true, force: true });
    }
  });
});

describe("install error paths", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("throws when required host file missing", () => {
    root = mkdtempSync(path.join(tmpdir(), "ahp-miss-"));
    agenthostsOk(root);
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    // missing src/index.ts and runner files
    expect(() => runInstall(root)).toThrow(/Missing required host file/);
  });

  it("verify flags missing transform files", () => {
    root = mkdtempSync(path.join(tmpdir(), "ahp-verify-"));
    agenthostsOk(root);
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "src/process-boot.ts", "export {};\n");
    writeFixture(root, "src/process-runtime.ts", "export {};\n");
    writeFixture(root, "src/process-onecli.ts", "export {};\n");
    const result = runVerify(root);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("src/index.ts"))).toBe(true);
  });
});

describe("resourcesDir", () => {
  it("points at host src in monorepo", () => {
    expect(resourcesDir()).toContain("packages/host/src");
  });
});
