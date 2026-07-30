import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agenthostsOk, writeFixture } from "./agenthosts.test.js";
import {
  printInstallNextSteps,
  runInstall,
  runUninstall,
  runUpgrade,
  runVerify,
} from "./install.js";
import { packageRoot } from "./paths.js";

function seedNanoclaw(root: string): void {
  agenthostsOk(root);
  writeFixture(
    root,
    "src/index.ts",
    `async function main() {\n  await startCliServer();\n  await initChannelAdapters();\n}\n`,
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
  writeFixture(
    root,
    "package.json",
    JSON.stringify({ name: "nanoclaw-fixture" }),
  );
}

describe("install lifecycle", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ahp-install-"));
    seedNanoclaw(root);
    // Ensure package root can resolve resources from monorepo host src.
    expect(
      existsSync(path.join(packageRoot(), "packages/host/src/process-boot.ts")),
    ).toBe(true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("install → verify → upgrade → uninstall", () => {
    const installed = runInstall(root);
    expect(installed.changed.length).toBeGreaterThan(0);
    expect(existsSync(path.join(root, "src/process-boot.ts"))).toBe(true);
    expect(existsSync(path.join(root, "src/process-runtime.ts"))).toBe(true);
    expect(
      existsSync(
        path.join(root, ".claude/skills/add-agenthost-process/SKILL.md"),
      ),
    ).toBe(true);
    expect(installed.runtimeDepsAdded).toContain("smol-toml");
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.["smol-toml"]).toMatch(/^\^/);
    expect(
      readFileSync(path.join(root, "src/process-runtime.ts"), "utf8"),
    ).toMatch(/from ["']smol-toml["']/);

    const index = readFileSync(path.join(root, "src/index.ts"), "utf8");
    expect(index).toContain("startAgenthostProcess");

    const connection = readFileSync(
      path.join(root, "container/agent-runner/src/db/connection.ts"),
      "utf8",
    );
    expect(connection).toContain("WORKING_ROOT");

    const verified = runVerify(root);
    expect(verified.ok).toBe(true);

    const upgraded = runUpgrade(root);
    expect(upgraded.unchanged.length).toBeGreaterThan(0);
    expect(upgraded.runtimeDepsAdded).toEqual([]);

    printInstallNextSteps(installed);

    const removed = runUninstall(root);
    expect(removed.removed).toContain("src/process-boot.ts");
    expect(removed.runtimeDepsRemoved).toContain("smol-toml");
    expect(existsSync(path.join(root, "src/process-boot.ts"))).toBe(false);
    expect(
      readFileSync(
        path.join(root, "container/agent-runner/src/db/connection.ts"),
        "utf8",
      ),
    ).toContain("/workspace/inbound.db");
    expect(readFileSync(path.join(root, "src/index.ts"), "utf8")).not.toContain(
      "startAgenthostProcess",
    );
    const pkgAfter = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkgAfter.dependencies?.["smol-toml"]).toBeUndefined();
  });

  it("verify accepts smol-toml listed under devDependencies", () => {
    runInstall(root);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "nanoclaw-fixture",
          devDependencies: { "smol-toml": "^1.7.1" },
        },
        null,
        2,
      ),
    );
    expect(runVerify(root).ok).toBe(true);
  });

  it("verify fails when smol-toml is missing from package.json", () => {
    runInstall(root);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "nanoclaw-fixture" }, null, 2),
    );
    const result = runVerify(root);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("smol-toml"))).toBe(true);
  });

  it("installed fork can resolve smol-toml when node_modules is linked", () => {
    runInstall(root);
    const hostSmol = path.join(
      packageRoot(),
      "packages/host/node_modules/smol-toml",
    );
    expect(existsSync(hostSmol)).toBe(true);
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(hostSmol, path.join(root, "node_modules/smol-toml"));
    const requireFromConsumer = createRequire(path.join(root, "package.json"));
    expect(requireFromConsumer.resolve("smol-toml")).toContain("smol-toml");
  });

  it("install fails without agenthosts", () => {
    rmSync(path.join(root, "src/agenthosts.ts"));
    expect(() => runInstall(root)).toThrow(/nanoclaw-agenthosts/);
  });

  it("verify reports issues when files missing after partial install", () => {
    runInstall(root);
    rmSync(path.join(root, "src/process-runtime.ts"));
    const result = runVerify(root);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("process-runtime"))).toBe(true);
  });

  it("install/verify/uninstall resolve NanoClaw root from cwd", () => {
    const prev = process.cwd();
    process.chdir(root);
    try {
      const installed = runInstall();
      expect(installed.root).toContain("ahp-install-");
      expect(runVerify().ok).toBe(true);
      // Missing transform file is skipped during uninstall.
      rmSync(path.join(root, "container/agent-runner/src/config.ts"));
      const removed = runUninstall();
      expect(removed.root).toContain("ahp-install-");
    } finally {
      process.chdir(prev);
    }
  });
});
