/**
 * Materialize OneCLI proxy env + CA files for a non-Docker (process) agent.
 * Writes certs under `runtimeDir` and rewrites path-valued env vars to host paths.
 */
import fs from "node:fs";
import path from "node:path";
import { ONECLI_API_KEY, ONECLI_URL } from "./config.js";

export interface ProcessOneCliClient {
  ensureAgent(opts: { name: string; identifier: string }): Promise<unknown>;
  getContainerConfig(opts?: { agent?: string }): Promise<{
    env: Record<string, string>;
    caCertificate?: string;
    caCertificateContainerPath?: string;
    combinedCaCertificate?: string;
    combinedCaCertificateContainerPath?: string;
    credentialStubs?: Array<{ containerPath: string; content: string }>;
  } | null>;
}

export interface ApplyProcessEnvOpts {
  runtimeDir: string;
  agentIdentifier?: string;
  agentName?: string;
  /** Synthetic HOME for process agents (maps /home/node stub paths). */
  homeDir?: string;
  /** Group .codex-shared path (maps /home/node/.codex stubs). */
  codexHome?: string;
  /** Injectable for tests; defaults to `@onecli-sh/sdk` OneCLI. */
  client?: ProcessOneCliClient;
}

export interface ApplyProcessEnvResult {
  ok: boolean;
  env: Record<string, string>;
}

/** Same search order as `@onecli-sh/sdk` buildCombinedCaBundle. */
const SYSTEM_CA_PATHS = [
  "/etc/ssl/cert.pem", // macOS
  "/etc/ssl/certs/ca-certificates.crt", // Debian / Ubuntu
  "/etc/pki/tls/certs/ca-bundle.crt", // RHEL / CentOS / Fedora
];

async function defaultClient(): Promise<ProcessOneCliClient> {
  const { OneCLI } = await import("@onecli-sh/sdk");
  // Match container-runner: prefer process.env, else config.ts (.env file).
  // LaunchAgents often omit ONECLI_* from the plist environment.
  return new OneCLI({
    url: process.env.ONECLI_URL || ONECLI_URL,
    apiKey: process.env.ONECLI_API_KEY || ONECLI_API_KEY,
  });
}

function writeCert(
  runtimeDir: string,
  filename: string,
  pem: string | undefined,
): string | null {
  if (!pem) return null;
  const dest = path.join(runtimeDir, filename);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(dest, pem, { mode: 0o600 });
  return dest;
}

/**
 * System trust store + OneCLI gateway CA — required for Codex/Rust (SSL_CERT_FILE)
 * and Deno; Node can use NODE_EXTRA_CA_CERTS alone but native CLIs cannot.
 */
export function buildCombinedCaBundlePem(gatewayCaPem: string): string | null {
  for (const sysPath of SYSTEM_CA_PATHS) {
    try {
      const sysCa = fs.readFileSync(sysPath, "utf8");
      return `${sysCa.trimEnd()}\n${gatewayCaPem.trimEnd()}\n`;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Ensure OneCLI agent (optional) and return env suitable for `spawn(..., { env })`.
 * Fail-closed: returns `{ ok: false }` when gateway config is unavailable.
 */
export async function applyProcessEnv(
  opts: ApplyProcessEnvOpts,
): Promise<ApplyProcessEnvResult> {
  fs.mkdirSync(opts.runtimeDir, { recursive: true });
  const client = opts.client ?? (await defaultClient());

  if (opts.agentIdentifier) {
    await client.ensureAgent({
      name: opts.agentName ?? opts.agentIdentifier,
      identifier: opts.agentIdentifier,
    });
  }

  const config = await client.getContainerConfig(
    opts.agentIdentifier ? { agent: opts.agentIdentifier } : undefined,
  );
  if (!config?.env) {
    return { ok: false, env: {} };
  }

  const env: Record<string, string> = { ...config.env };

  const caPath = writeCert(
    opts.runtimeDir,
    "onecli-gateway-ca.pem",
    config.caCertificate,
  );
  if (caPath) {
    env.NODE_EXTRA_CA_CERTS = caPath;
  }

  const combinedPem =
    config.combinedCaCertificate ??
    (config.caCertificate
      ? buildCombinedCaBundlePem(config.caCertificate)
      : null);
  const combinedPath = writeCert(
    opts.runtimeDir,
    "onecli-combined-ca.pem",
    combinedPem ?? undefined,
  );
  if (combinedPath) {
    // Match OneCLI applyContainerConfig — Codex/Rust honor SSL_CERT_FILE.
    env.SSL_CERT_FILE = combinedPath;
    env.DENO_CERT = combinedPath;
  }

  materializeCredentialStubs(config.credentialStubs, {
    homeDir: opts.homeDir,
    codexHome: opts.codexHome,
  });

  // Container paths from the SDK are meaningless on the host — drop any leftover.
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (
      (key === "NODE_EXTRA_CA_CERTS" ||
        key === "SSL_CERT_FILE" ||
        key === "DENO_CERT") &&
      value.startsWith("/tmp/") &&
      !fs.existsSync(value)
    ) {
      delete env[key];
    }
  }

  // Docker-oriented gateway hostnames do not resolve on the host process network.
  rewriteDockerInternalHostnames(env);

  return { ok: true, env };
}

/** Map host.docker.internal → 127.0.0.1 in OneCLI proxy / URL env values. */
export function rewriteDockerInternalHostnames(
  env: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(env)) {
    if (value.includes("host.docker.internal")) {
      env[key] = value.split("host.docker.internal").join("127.0.0.1");
    }
  }
}

/**
 * Write OneCLI credential stubs into process-mode paths (Docker mounts these
 * at containerPath under /home/node).
 */
export function materializeCredentialStubs(
  stubs: Array<{ containerPath: string; content: string }> | undefined,
  opts: { homeDir?: string; codexHome?: string },
): void {
  if (!stubs?.length) return;
  for (const stub of stubs) {
    const dest = mapContainerStubPath(stub.containerPath, opts);
    if (!dest) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, stub.content, { mode: 0o600 });
  }
}

function mapContainerStubPath(
  containerPath: string,
  opts: { homeDir?: string; codexHome?: string },
): string | null {
  const normalized = containerPath.replace(/\\/g, "/");
  if (opts.codexHome && normalized.startsWith("/home/node/.codex/")) {
    return path.join(
      opts.codexHome,
      normalized.slice("/home/node/.codex/".length),
    );
  }
  if (opts.homeDir && normalized.startsWith("/home/node/")) {
    return path.join(opts.homeDir, normalized.slice("/home/node/".length));
  }
  // Bare "/home/node" (or "/home/nodeXYZ") is not a writable file target when
  // homeDir is the synthetic HOME directory — skip rather than EISDIR.
  return null;
}
