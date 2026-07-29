import fs from "node:fs";
import path from "node:path";

/** Pinned contract — keep in sync with nanoclaw-agenthosts API version 1. */
export const EXPECTED_AGENTHOSTS_API_VERSION = 1 as const;

const INSTALL_GUIDANCE =
  "Install nanoclaw-agenthosts@^0.1.0 (API v1) first, then rebuild the host. " +
  "See https://github.com/Artificer-Innovations/nanoclaw-agenthosts";

interface AgenthostsRequirement {
  path: string;
  tokens: string[];
}

/**
 * Tokens expected after `nanoclaw-agenthosts install`.
 * Coordinated with the agenthosts package design / api-contract.
 */
const REQUIREMENTS: AgenthostsRequirement[] = [
  {
    path: "src/agenthosts.ts",
    tokens: [
      `AGENTHOSTS_API_VERSION = ${EXPECTED_AGENTHOSTS_API_VERSION}`,
      "registerRuntimeDriver",
      "resolveRuntimeDriver",
    ],
  },
  {
    path: "src/container-runner.ts",
    tokens: [
      // Shipped agenthosts installer uses *-rename markers around docker impls
      // plus public-exports that route wake through resolveRuntimeDriver.
      "@nanoclaw-agenthosts:wake-rename:begin",
      "@nanoclaw-agenthosts:kill-rename:begin",
      "@nanoclaw-agenthosts:is-running-rename:begin",
      "@nanoclaw-agenthosts:public-exports:begin",
      "resolveRuntimeDriver",
    ],
  },
];

export function findAgenthostsIssues(nanoclawRoot: string): string[] {
  const issues: string[] = [];
  for (const requirement of REQUIREMENTS) {
    const filePath = path.join(nanoclawRoot, requirement.path);
    if (!fs.existsSync(filePath)) {
      issues.push(`missing agenthosts file ${requirement.path}`);
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    for (const token of requirement.tokens) {
      if (!source.includes(token)) {
        issues.push(
          `${requirement.path} missing agenthosts API v${EXPECTED_AGENTHOSTS_API_VERSION} capability ${token}`,
        );
      }
    }
  }
  return issues;
}

export function agenthostsInstallGuidance(): string {
  return INSTALL_GUIDANCE;
}

export function requireAgenthosts(nanoclawRoot: string): void {
  const issues = findAgenthostsIssues(nanoclawRoot);
  if (issues.length === 0) return;
  throw new Error(
    `nanoclaw-agenthosts API v${EXPECTED_AGENTHOSTS_API_VERSION} is required (${issues.join("; ")}). ${INSTALL_GUIDANCE}`,
  );
}
