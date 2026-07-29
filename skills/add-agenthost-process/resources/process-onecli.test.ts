import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  ONECLI_URL: "http://127.0.0.1:10254",
  ONECLI_API_KEY: "test-key",
}));

import { applyProcessEnv, type ProcessOneCliClient } from "./process-onecli.js";

describe("applyProcessEnv", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns ok:false when gateway config is missing", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => null),
    };
    const result = await applyProcessEnv({
      runtimeDir: dir,
      agentIdentifier: "ag-1",
      agentName: "Test",
      client,
    });
    expect(result.ok).toBe(false);
    expect(client.ensureAgent).toHaveBeenCalledWith({
      name: "Test",
      identifier: "ag-1",
    });
  });

  it("writes CA files and rewrites env paths", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => ({
        env: {
          HTTPS_PROXY: "http://127.0.0.1:10255",
          HTTP_PROXY: "http://127.0.0.1:10255",
          NODE_USE_ENV_PROXY: "1",
          NODE_EXTRA_CA_CERTS: "/tmp/onecli-gateway-ca.pem",
        },
        caCertificate:
          "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n",
        combinedCaCertificate:
          "-----BEGIN CERTIFICATE-----\nDEF\n-----END CERTIFICATE-----\n",
      })),
    };

    const result = await applyProcessEnv({
      runtimeDir: path.join(dir, "rt"),
      agentIdentifier: "ag-1",
      client,
    });

    expect(result.ok).toBe(true);
    expect(result.env.HTTPS_PROXY).toBe("http://127.0.0.1:10255");
    expect(result.env.NODE_EXTRA_CA_CERTS).toBe(
      path.join(dir, "rt", "onecli-gateway-ca.pem"),
    );
    expect(result.env.SSL_CERT_FILE).toBe(
      path.join(dir, "rt", "onecli-combined-ca.pem"),
    );
    expect(result.env.DENO_CERT).toBe(result.env.SSL_CERT_FILE);
    expect(readFileSync(result.env.NODE_EXTRA_CA_CERTS!, "utf8")).toContain(
      "BEGIN CERTIFICATE",
    );
    expect(existsSync(result.env.SSL_CERT_FILE!)).toBe(true);
  });

  it("builds combined CA from system store when API omits combinedCaCertificate", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const gateway =
      "-----BEGIN CERTIFICATE-----\nGATEWAY\n-----END CERTIFICATE-----\n";
    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => ({
        env: { HTTPS_PROXY: "http://127.0.0.1:10255" },
        caCertificate: gateway,
      })),
    };
    const result = await applyProcessEnv({ runtimeDir: dir, client });
    expect(result.ok).toBe(true);
    expect(result.env.SSL_CERT_FILE).toBe(
      path.join(dir, "onecli-combined-ca.pem"),
    );
    expect(result.env.DENO_CERT).toBe(result.env.SSL_CERT_FILE);
    const combined = readFileSync(result.env.SSL_CERT_FILE!, "utf8");
    expect(combined).toContain("GATEWAY");
    expect(combined.length).toBeGreaterThan(gateway.length);
  });

  it("drops stale /tmp CA paths when certs were not provided", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    mkdirSync(dir, { recursive: true });
    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => ({
        env: {
          HTTPS_PROXY: "http://proxy",
          NODE_EXTRA_CA_CERTS: "/tmp/onecli-gateway-ca.pem",
          SSL_CERT_FILE: "/tmp/onecli-combined-ca.pem",
        },
      })),
    };
    const result = await applyProcessEnv({ runtimeDir: dir, client });
    expect(result.ok).toBe(true);
    expect(result.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.env.SSL_CERT_FILE).toBeUndefined();
    expect(result.env.HTTPS_PROXY).toBe("http://proxy");
  });

  it("rewrites host.docker.internal proxy hosts for process agents", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => ({
        env: {
          HTTPS_PROXY:
            "http://x:token@host.docker.internal:10255",
          HTTP_PROXY: "http://x:token@host.docker.internal:10255",
          https_proxy:
            "http://x:token@host.docker.internal:10255",
        },
      })),
    };
    const result = await applyProcessEnv({ runtimeDir: dir, client });
    expect(result.ok).toBe(true);
    expect(result.env.HTTPS_PROXY).toBe("http://x:token@127.0.0.1:10255");
    expect(result.env.HTTP_PROXY).toBe("http://x:token@127.0.0.1:10255");
    expect(result.env.https_proxy).toBe("http://x:token@127.0.0.1:10255");
  });

  it("writes credential stubs under process HOME/CODEX_HOME", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const homeDir = path.join(dir, "home");
    const codexHome = path.join(dir, "codex");
    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => ({
        env: { HTTPS_PROXY: "http://127.0.0.1:10255" },
        caCertificate:
          "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n",
        credentialStubs: [
          {
            containerPath: "/home/node/.codex/auth.json",
            content: '{"OPENAI_API_KEY":"placeholder"}',
          },
        ],
      })),
    };
    const result = await applyProcessEnv({
      runtimeDir: dir,
      homeDir,
      codexHome,
      client,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(codexHome, "auth.json"), "utf8")).toContain(
      "placeholder",
    );
  });
});
