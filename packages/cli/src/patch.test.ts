import { describe, expect, it } from "vitest";
import {
  hasProcessBootBlock,
  insertProcessBootBlockContent,
  removeProcessBootBlockContent,
  patchWorkingRootPaths,
  unpatchWorkingRootPaths,
  patchWorkingRootCwd,
  unpatchWorkingRootCwd,
  patchWorkingRootConfig,
  unpatchWorkingRootConfig,
  findProcessBootInsertIndex,
} from "./patch.js";

describe("boot block", () => {
  it("inserts after startCliServer and is idempotent", () => {
    const source = `async function main() {\n  await startCliServer();\n  await initChannelAdapters();\n}\n`;
    const once = insertProcessBootBlockContent(source);
    expect(hasProcessBootBlock(once)).toBe(true);
    expect(once).toContain("startAgenthostProcess");
    const twice = insertProcessBootBlockContent(once);
    expect(twice).toBe(once);
    const removed = removeProcessBootBlockContent(once);
    expect(hasProcessBootBlock(removed)).toBe(false);
  });

  it("finds insert point before initChannelAdapters", () => {
    const source = `  initChannelAdapters();\n`;
    expect(findProcessBootInsertIndex(source)).toBeGreaterThanOrEqual(0);
  });

  it("throws when no insert point", () => {
    expect(() =>
      insertProcessBootBlockContent("export const x = 1;\n"),
    ).toThrow(/boot insert point/);
  });
});

describe("WORKING_ROOT patches", () => {
  const connection = `const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';
`;

  it("patches and unpatches connection paths", () => {
    const patched = patchWorkingRootPaths(connection);
    expect(patched).toContain("WORKING_ROOT");
    expect(patchWorkingRootPaths(patched)).toBe(patched);
    const restored = unpatchWorkingRootPaths(patched);
    expect(restored).toContain("/workspace/inbound.db");
    expect(restored).not.toContain("working-root-paths:begin");
  });

  it("throws when connection anchors missing", () => {
    expect(() => patchWorkingRootPaths("const x = 1;\n")).toThrow(
      /anchors moved/,
    );
  });

  it("patches and unpatches CWD + memory scaffold", () => {
    const source = `const CWD = '/workspace/agent';\nensureMemoryScaffold();\n`;
    const patched = patchWorkingRootCwd(source);
    expect(patched).toContain("WORKING_ROOT");
    expect(patched).toContain("ensureMemoryScaffold(CWD);");
    expect(unpatchWorkingRootCwd(patched)).toContain(
      "const CWD = '/workspace/agent';",
    );
    expect(unpatchWorkingRootCwd(patched)).toContain("ensureMemoryScaffold();");
  });

  it("throws when CWD anchor missing", () => {
    expect(() => patchWorkingRootCwd('const CWD = "other";\n')).toThrow(
      /anchors moved/,
    );
  });

  it("patches and unpatches CONFIG_PATH", () => {
    const source = `const CONFIG_PATH = '/workspace/agent/container.json';\n`;
    const patched = patchWorkingRootConfig(source);
    expect(patched).toContain("WORKING_ROOT");
    expect(patchWorkingRootConfig(patched)).toBe(patched);
    expect(unpatchWorkingRootConfig(patched)).toBe(source);
  });

  it("throws when CONFIG_PATH anchor missing", () => {
    expect(() =>
      patchWorkingRootConfig("const CONFIG_PATH = 'other';\n"),
    ).toThrow(/anchors moved/);
  });

  it("unpatch helpers are no-ops without markers", () => {
    expect(unpatchWorkingRootConfig("x")).toBe("x");
    expect(unpatchWorkingRootPaths("x")).toBe("x");
    expect(unpatchWorkingRootCwd("x")).toBe("x");
  });
});
