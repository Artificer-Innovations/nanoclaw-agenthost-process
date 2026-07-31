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
    expect(removed).not.toMatch(/(?:\r?\n){3,}/);
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

  it("collapses CRLF blank runs after boot-block removal", () => {
    const source =
      "async function main() {\r\n  await startCliServer();\r\n  await initChannelAdapters();\r\n}\r\n";
    const withBoot = insertProcessBootBlockContent(source);
    // Simulate extra blank lines around the removal site (CRLF).
    const padded = withBoot.replace(
      "\r\n  await initChannelAdapters()",
      "\r\n\r\n\r\n  await initChannelAdapters()",
    );
    const removed = removeProcessBootBlockContent(padded);
    expect(hasProcessBootBlock(removed)).toBe(false);
    expect(removed).not.toMatch(/(?:\r?\n){3,}/);
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
    const source = `const CWD = '/workspace/agent';\nensureMemoryScaffold();\nensureMemoryScaffold();\n`;
    const patched = patchWorkingRootCwd(source);
    expect(patched).toContain("WORKING_ROOT");
    expect(patched).toContain("pre-patch-cwd:");
    expect(patched).not.toContain("ensureMemoryScaffold();");
    expect(patched.match(/ensureMemoryScaffold\(CWD\);/g)?.length).toBe(2);
    expect(unpatchWorkingRootCwd(patched)).toContain(
      "const CWD = '/workspace/agent';",
    );
    expect(unpatchWorkingRootCwd(patched)).toContain("ensureMemoryScaffold();");
    expect(unpatchWorkingRootCwd(patched)).not.toContain(
      "ensureMemoryScaffold(CWD)",
    );
  });

  it("unpatches CWD to Docker default when pre-patch marker is missing", () => {
    const withoutMarker = `${`// ${"@nanoclaw-agenthost-process"}:working-root-cwd:begin`}
const CWD = process.env.WORKING_ROOT
  ? \`\${process.env.WORKING_ROOT}/agent\`
  : '/workspace/agent';
${`// ${"@nanoclaw-agenthost-process"}:working-root-cwd:end`}
ensureMemoryScaffold(CWD);
`;
    expect(unpatchWorkingRootCwd(withoutMarker)).toContain(
      "const CWD = '/workspace/agent';",
    );
  });

  it("throws when CWD anchor missing", () => {
    expect(() => patchWorkingRootCwd('const CWD = "other";\n')).toThrow(
      /anchors moved/,
    );
  });

  it("patches remaining scaffold calls when CWD block already present", () => {
    const begin = `// ${"@nanoclaw-agenthost-process"}:working-root-cwd:begin`;
    const end = `// ${"@nanoclaw-agenthost-process"}:working-root-cwd:end`;
    const source = `${begin}
// @nanoclaw-agenthost-process:pre-patch-cwd: const CWD = '/workspace/agent';
const CWD = process.env.WORKING_ROOT
  ? \`\${process.env.WORKING_ROOT}/agent\`
  : '/workspace/agent';
${end}
ensureMemoryScaffold();
`;
    const patched = patchWorkingRootCwd(source);
    expect(patched).toContain("ensureMemoryScaffold(CWD);");
    expect(patched).not.toContain("ensureMemoryScaffold();");
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
