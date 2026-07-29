import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCliEntry, main, parseArgs, runCommand } from "./bin.js";
import * as install from "./install.js";
import {
  findNanoclawRoot,
  hostSrcDir,
  packageRoot,
  readPackageVersion,
  resourcesDir,
  skillDir,
} from "./paths.js";

describe("bin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseArgs reads command and --path", () => {
    expect(parseArgs(["node", "bin.js", "verify", "--path", "/tmp/x"])).toEqual(
      {
        command: "verify",
        path: "/tmp/x",
      },
    );
    expect(parseArgs(["node", "bin.js"]).command).toBe("help");
  });

  it("runCommand help returns 0", () => {
    expect(runCommand(["node", "bin.js", "help"])).toBe(0);
  });

  it("runCommand unknown returns 1", () => {
    expect(runCommand(["node", "bin.js", "nope"])).toBe(1);
  });

  it("isCliEntry compares paths safely", () => {
    expect(isCliEntry("/no/such", ["node"])).toBe(false);
    const self = fileURLToPath(import.meta.url);
    expect(isCliEntry(self, ["node", self])).toBe(true);
    expect(isCliEntry("/missing-a", ["node", "/missing-a"])).toBe(true);
  });

  it("main exits with runCommand status", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const prev = process.argv;
    process.argv = ["node", "bin.js", "help"];
    try {
      expect(() => main()).toThrow(/exit:0/);
    } finally {
      process.argv = prev;
    }
  });

  it("runCommand prints non-Error throws", () => {
    vi.spyOn(install, "runInstall").mockImplementation(() => {
      throw "raw-failure";
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCommand(["node", "bin.js", "install", "--path", "/tmp"])).toBe(1);
    expect(err).toHaveBeenCalledWith("raw-failure");
  });
});

describe("paths", () => {
  it("resolves package root and resources", () => {
    const root = packageRoot();
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(resourcesDir()).toContain("packages/host/src");
    expect(skillDir()).toContain("add-agenthost-process");
    expect(hostSrcDir()).toContain("packages/host/src");
  });

  it("findNanoclawRoot throws outside a fork", () => {
    expect(() => findNanoclawRoot("/tmp")).toThrow(/NanoClaw root not found/);
  });

  it("findNanoclawRoot walks up to a fork", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ahp-nc-root-"));
    try {
      mkdirSync(path.join(root, "src/channels"), { recursive: true });
      writeFileSync(path.join(root, "src/channels/index.ts"), "export {};\n");
      writeFileSync(path.join(root, "src/index.ts"), "export {};\n");
      const nested = path.join(root, "a", "b");
      mkdirSync(nested, { recursive: true });
      expect(findNanoclawRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
