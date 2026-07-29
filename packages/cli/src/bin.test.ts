import { describe, expect, it } from "vitest";
import { isCliEntry, parseArgs, runCommand } from "./bin.js";
import {
  findNanoclawRoot,
  packageRoot,
  readPackageVersion,
  resourcesDir,
} from "./paths.js";
import path from "node:path";
import { existsSync } from "node:fs";

describe("bin", () => {
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
  });
});

describe("paths", () => {
  it("resolves package root and resources", () => {
    const root = packageRoot();
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(resourcesDir()).toContain("packages/host/src");
  });

  it("findNanoclawRoot throws outside a fork", () => {
    expect(() => findNanoclawRoot("/tmp")).toThrow(/NanoClaw root not found/);
  });
});
