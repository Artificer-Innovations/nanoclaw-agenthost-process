import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  consumerRuntimeDependencies,
  ensureConsumerRuntimeDependencies,
  findMissingConsumerRuntimeDependencies,
  packageRoot,
  readPackageVersion,
  removeConsumerRuntimeDependencies,
  resourcesDir,
} from "./paths.js";
import { runInstall, runUninstall, runVerify } from "./install.js";
import fs from "node:fs";

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
    expect(runCommand(["node", "bin.js", "upgrade", "--path", root])).toBe(0);
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

  it("sync-skill without --path uses findNanoclawRoot from cwd", () => {
    seed();
    const prev = process.cwd();
    process.chdir(root);
    try {
      expect(runCommand(["node", "bin.js", "sync-skill"])).toBe(0);
    } finally {
      process.chdir(prev);
    }
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

  it("inserts before awaited initChannelAdapters", () => {
    const source = `async function main() {\n  await initChannelAdapters();\n}\n`;
    expect(findProcessBootInsertIndex(source)).toBeGreaterThanOrEqual(0);
    expect(insertProcessBootBlockContent(source)).toContain(
      "startAgenthostProcess",
    );
  });

  it("resolveCopySources skips optional missing files", () => {
    const root = packageRoot();
    const resolved = resolveCopySources(root, HOST_OPTIONAL_COPY_RULES, true);
    expect(resolved.length).toBeGreaterThan(0);
    const mixed = resolveCopySources(
      root,
      [
        ...HOST_OPTIONAL_COPY_RULES.slice(0, 1),
        { source: "missing-optional-resource.ts", dest: "src/missing.ts" },
      ],
      true,
    );
    expect(mixed.length).toBe(1);
  });

  it("resolveCopySources throws when required resource missing", () => {
    expect(() =>
      resolveCopySources(packageRoot(), [
        { source: "does-not-exist-resource.ts", dest: "src/x.ts" },
      ]),
    ).toThrow(/Missing bundled resource/);
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

  it("syncSkillToFork replaces a non-directory destination", () => {
    const destRoot = mkdtempSync(path.join(tmpdir(), "skill-sync-file-"));
    try {
      mkdirSync(path.join(destRoot, ".claude/skills"), { recursive: true });
      writeFileSync(
        path.join(destRoot, ".claude/skills/add-agenthost-process"),
        "not-a-dir",
      );
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

  it("rolls back committed files when a later write fails", () => {
    root = mkdtempSync(path.join(tmpdir(), "ahp-rollback-"));
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
    const original = fs.renameSync.bind(fs);
    let renames = 0;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renames += 1;
      // Fail after transforms + first new host file so rollback covers both
      // previous===null (new) and previous!==null (edited) restores.
      if (renames === 6) {
        throw new Error("simulated write failure");
      }
      return original(from, to);
    });
    try {
      expect(() => runInstall(root)).toThrow(/simulated write failure/);
      expect(existsSync(path.join(root, "src/process-boot.ts"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("resourcesDir", () => {
  it("points at host src in monorepo", () => {
    expect(resourcesDir()).toContain("packages/host/src");
  });

  it("falls back to skill resources when packages/host/src is absent", () => {
    const fake = mkdtempSync(path.join(tmpdir(), "ahp-paths-"));
    try {
      writeFileSync(
        path.join(fake, "package.json"),
        JSON.stringify({
          name: "nanoclaw-agenthost-process",
          version: "0.0.0",
        }),
      );
      mkdirSync(path.join(fake, "skills/add-agenthost-process/resources"), {
        recursive: true,
      });
      mkdirSync(path.join(fake, "packages/cli/src"), { recursive: true });
      const start = path.join(fake, "packages/cli/src");
      expect(resourcesDir(start)).toBe(
        path.join(fake, "skills/add-agenthost-process/resources"),
      );
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it("resolves file: linked host src from a NanoClaw root", () => {
    const linkedPkg = mkdtempSync(path.join(tmpdir(), "ahp-linked-pkg-"));
    const nanoclaw = mkdtempSync(path.join(tmpdir(), "ahp-linked-nc-"));
    try {
      writeFileSync(
        path.join(linkedPkg, "package.json"),
        JSON.stringify({
          name: "nanoclaw-agenthost-process",
          version: "0.0.0",
        }),
      );
      mkdirSync(path.join(linkedPkg, "packages/host/src"), { recursive: true });
      writeFileSync(
        path.join(linkedPkg, "packages/host/src/process-boot.ts"),
        "export {};\n",
      );
      const fakeCli = mkdtempSync(path.join(tmpdir(), "ahp-cli-start-"));
      writeFileSync(
        path.join(fakeCli, "package.json"),
        JSON.stringify({
          name: "nanoclaw-agenthost-process",
          version: "0.0.0",
        }),
      );
      writeFileSync(
        path.join(nanoclaw, "package.json"),
        JSON.stringify({
          name: "nanoclaw",
          dependencies: {
            "nanoclaw-agenthost-process": `file:${linkedPkg}`,
          },
        }),
      );
      mkdirSync(path.join(fakeCli, "skills/add-agenthost-process/resources"), {
        recursive: true,
      });
      expect(resourcesDir(fakeCli, nanoclaw)).toBe(
        path.join(linkedPkg, "packages/host/src"),
      );
      rmSync(fakeCli, { recursive: true, force: true });
    } finally {
      rmSync(linkedPkg, { recursive: true, force: true });
      rmSync(nanoclaw, { recursive: true, force: true });
    }
  });

  it("ignores non-file: deps and missing package.json when resolving linked src", () => {
    const fakeCli = mkdtempSync(path.join(tmpdir(), "ahp-nofile-"));
    const nanoclaw = mkdtempSync(path.join(tmpdir(), "ahp-reg-"));
    try {
      writeFileSync(
        path.join(fakeCli, "package.json"),
        JSON.stringify({
          name: "nanoclaw-agenthost-process",
          version: "0.0.0",
        }),
      );
      mkdirSync(path.join(fakeCli, "skills/add-agenthost-process/resources"), {
        recursive: true,
      });
      writeFileSync(
        path.join(nanoclaw, "package.json"),
        JSON.stringify({
          name: "nanoclaw",
          dependencies: { "nanoclaw-agenthost-process": "^0.1.0" },
        }),
      );
      expect(resourcesDir(fakeCli, nanoclaw)).toBe(
        path.join(fakeCli, "skills/add-agenthost-process/resources"),
      );
      expect(resourcesDir(fakeCli, path.join(nanoclaw, "missing"))).toBe(
        path.join(fakeCli, "skills/add-agenthost-process/resources"),
      );

      // Prefer devDependencies file: link when dependencies omit the package.
      const linkedPkg = mkdtempSync(path.join(tmpdir(), "ahp-devdep-"));
      mkdirSync(path.join(linkedPkg, "packages/host/src"), { recursive: true });
      writeFileSync(
        path.join(linkedPkg, "packages/host/src/process-boot.ts"),
        "export {};\n",
      );
      writeFileSync(
        path.join(nanoclaw, "package.json"),
        JSON.stringify({
          name: "nanoclaw",
          devDependencies: {
            "nanoclaw-agenthost-process": `file:${linkedPkg}`,
          },
        }),
      );
      expect(resourcesDir(fakeCli, nanoclaw)).toBe(
        path.join(linkedPkg, "packages/host/src"),
      );

      // Linked package without process-boot.ts falls back to skill resources.
      rmSync(path.join(linkedPkg, "packages/host/src/process-boot.ts"));
      expect(resourcesDir(fakeCli, nanoclaw)).toBe(
        path.join(fakeCli, "skills/add-agenthost-process/resources"),
      );
      rmSync(linkedPkg, { recursive: true, force: true });
    } finally {
      rmSync(fakeCli, { recursive: true, force: true });
      rmSync(nanoclaw, { recursive: true, force: true });
    }
  });

  it("readPackageVersion falls back when version is omitted", () => {
    const pkgPath = path.join(packageRoot(), "package.json");
    const original = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      enc?: unknown,
    ) => {
      if (p === pkgPath) {
        return JSON.stringify({ name: "nanoclaw-agenthost-process" });
      }
      return original(p, enc as BufferEncoding);
    }) as typeof fs.readFileSync);
    try {
      expect(readPackageVersion()).toBe("0.0.0");
    } finally {
      spy.mockRestore();
    }
  });

  it("packageRoot throws outside the package", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "not-ahp-"));
    try {
      expect(() => packageRoot(dir)).toThrow(
        /Could not locate nanoclaw-agenthost-process package root/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consumerRuntimeDependencies falls back when host package.json is absent", () => {
    const fake = mkdtempSync(path.join(tmpdir(), "ahp-pub-"));
    try {
      writeFileSync(
        path.join(fake, "package.json"),
        JSON.stringify({ name: "nanoclaw-agenthost-process" }),
      );
      // No packages/host/package.json → published-layout pin.
      expect(consumerRuntimeDependencies(fake)).toEqual({
        "smol-toml": "^1.7.1",
      });
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it("consumerRuntimeDependencies omits smol-toml when host package has no pin", () => {
    const fake = mkdtempSync(path.join(tmpdir(), "ahp-nopin-"));
    try {
      writeFileSync(
        path.join(fake, "package.json"),
        JSON.stringify({ name: "nanoclaw-agenthost-process" }),
      );
      mkdirSync(path.join(fake, "packages/host"), { recursive: true });
      writeFileSync(
        path.join(fake, "packages/host/package.json"),
        JSON.stringify({ name: "@nanoclaw-agenthost-process/host" }),
      );
      expect(consumerRuntimeDependencies(fake)).toEqual({});
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it("ensureConsumerRuntimeDependencies throws without package.json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ahp-nodeps-"));
    try {
      expect(() => ensureConsumerRuntimeDependencies(dir)).toThrow(
        /Missing package.json/,
      );
      expect(
        findMissingConsumerRuntimeDependencies(dir).some((i) =>
          i.includes("smol-toml"),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removeConsumerRuntimeDependencies keeps smol-toml while process-runtime.ts remains", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ahp-keepdep-"));
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "fork",
          dependencies: { "smol-toml": "^1.7.1" },
        }),
      );
      mkdirSync(path.join(dir, "src"), { recursive: true });
      writeFileSync(path.join(dir, "src/process-runtime.ts"), "export {};\n");
      expect(removeConsumerRuntimeDependencies(dir)).toEqual({
        changed: false,
        removed: [],
      });
      expect(
        JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
          .dependencies["smol-toml"],
      ).toBe("^1.7.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removeConsumerRuntimeDependencies drops smol-toml when process-runtime.ts is gone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ahp-rmdep-"));
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "fork",
          dependencies: { "smol-toml": "^1.7.1", other: "1.0.0" },
          devDependencies: { "smol-toml": "^1.7.1" },
        }),
      );
      const result = removeConsumerRuntimeDependencies(dir);
      expect(result.changed).toBe(true);
      expect(result.removed).toContain("smol-toml");
      const pkg = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.["smol-toml"]).toBeUndefined();
      expect(pkg.dependencies?.other).toBe("1.0.0");
      expect(pkg.devDependencies).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
