import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_AGENTHOSTS_API_VERSION,
  findAgenthostsIssues,
  requireAgenthosts,
} from "./agenthosts.js";

function writeFixture(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function agenthostsOk(root: string): void {
  writeFixture(
    root,
    "src/agenthosts.ts",
    `export const AGENTHOSTS_API_VERSION = ${EXPECTED_AGENTHOSTS_API_VERSION} as const;\nexport function registerRuntimeDriver() {}\nexport function resolveRuntimeDriver() {}\n`,
  );
  writeFixture(
    root,
    "src/container-runner.ts",
    `// @nanoclaw-agenthosts:wake-rename:begin
// wakeContainer → wakeContainerDocker
// @nanoclaw-agenthosts:wake-rename:end
// @nanoclaw-agenthosts:kill-rename:begin
// killContainer → killContainerDocker
// @nanoclaw-agenthosts:kill-rename:end
// @nanoclaw-agenthosts:is-running-rename:begin
// isContainerRunning → isContainerRunningDocker
// @nanoclaw-agenthosts:is-running-rename:end
// @nanoclaw-agenthosts:public-exports:begin
export function wakeContainer(session) { return resolveRuntimeDriver(session).wake(session, {}); }
// @nanoclaw-agenthosts:public-exports:end
`,
  );
}

describe("requireAgenthosts", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("passes when tokens are present", () => {
    root = mkdtempSync(path.join(tmpdir(), "ah-ok-"));
    agenthostsOk(root);
    expect(findAgenthostsIssues(root)).toEqual([]);
    expect(() => requireAgenthosts(root)).not.toThrow();
  });

  it("fails when agenthosts is missing", () => {
    root = mkdtempSync(path.join(tmpdir(), "ah-missing-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    expect(findAgenthostsIssues(root).length).toBeGreaterThan(0);
    expect(() => requireAgenthosts(root)).toThrow(/nanoclaw-agenthosts API v1/);
  });
});

export { agenthostsOk, writeFixture };
