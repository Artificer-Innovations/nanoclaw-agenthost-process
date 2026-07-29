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

const oneCliCtor = vi.fn();

vi.mock("./config.js", () => ({
  ONECLI_URL: "http://127.0.0.1:10254",
  ONECLI_API_KEY: "config-fallback-key",
}));

vi.mock("@onecli-sh/sdk", () => ({
  OneCLI: class {
    constructor(opts: unknown) {
      oneCliCtor(opts);
    }
    ensureAgent = vi.fn(async () => {});
    getContainerConfig = vi.fn(async () => ({
      env: { HTTPS_PROXY: "http://from-default-client" },
    }));
  },
}));

import {
  applyProcessEnv,
  buildCombinedCaBundlePem,
  materializeCredentialStubs,
  rewriteDockerInternalHostnames,
  type ProcessOneCliClient,
} from "./process-onecli.js";
import fs from "node:fs";

describe("applyProcessEnv", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    oneCliCtor.mockClear();
    delete process.env.ONECLI_URL;
    delete process.env.ONECLI_API_KEY;
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

  it("falls back to config.js OneCLI URL/key when LaunchAgent env omits them", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    delete process.env.ONECLI_URL;
    delete process.env.ONECLI_API_KEY;
    const result = await applyProcessEnv({ runtimeDir: dir });
    expect(result.ok).toBe(true);
    expect(oneCliCtor).toHaveBeenCalledWith({
      url: "http://127.0.0.1:10254",
      apiKey: "config-fallback-key",
    });
    expect(result.env.HTTPS_PROXY).toBe("http://from-default-client");
  });

  it("prefers process.env OneCLI credentials over config.js", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    process.env.ONECLI_URL = "http://env-url";
    process.env.ONECLI_API_KEY = "env-key";
    await applyProcessEnv({ runtimeDir: dir });
    expect(oneCliCtor).toHaveBeenCalledWith({
      url: "http://env-url",
      apiKey: "env-key",
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

  it("omits SSL_CERT_FILE when combined CA cannot be built", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const original = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      enc?: unknown,
    ) => {
      if (typeof p === "string" && p.startsWith("/etc/")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return original(p, enc as BufferEncoding);
    }) as typeof fs.readFileSync);

    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => ({
        env: { HTTPS_PROXY: "http://127.0.0.1:10255" },
        caCertificate:
          "-----BEGIN CERTIFICATE-----\nGATEWAY\n-----END CERTIFICATE-----\n",
      })),
    };
    try {
      const result = await applyProcessEnv({ runtimeDir: dir, client });
      expect(result.ok).toBe(true);
      expect(result.env.NODE_EXTRA_CA_CERTS).toBeDefined();
      expect(result.env.SSL_CERT_FILE).toBeUndefined();
      expect(result.env.DENO_CERT).toBeUndefined();
    } finally {
      readSpy.mockRestore();
    }
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
          DENO_CERT: "/tmp/onecli-combined-ca.pem",
        },
      })),
    };
    const result = await applyProcessEnv({ runtimeDir: dir, client });
    expect(result.ok).toBe(true);
    expect(result.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.env.SSL_CERT_FILE).toBeUndefined();
    expect(result.env.DENO_CERT).toBeUndefined();
    expect(result.env.HTTPS_PROXY).toBe("http://proxy");
  });

  it("rewrites host.docker.internal proxy hosts for process agents", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const client: ProcessOneCliClient = {
      ensureAgent: vi.fn(async () => {}),
      getContainerConfig: vi.fn(async () => ({
        env: {
          HTTPS_PROXY: "http://x:token@host.docker.internal:10255",
          HTTP_PROXY: "http://x:token@host.docker.internal:10255",
          https_proxy: "http://x:token@host.docker.internal:10255",
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
          {
            containerPath: "/home/node/.config/foo",
            content: "home-stub",
          },
          {
            containerPath: "/unmapped/path",
            content: "skip-me",
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
    expect(readFileSync(path.join(homeDir, ".config/foo"), "utf8")).toBe(
      "home-stub",
    );
    expect(existsSync(path.join(dir, "unmapped"))).toBe(false);
  });

  it("skips bare /home/node stubs (homeDir is a directory, not a file)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    const homeDir = path.join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    materializeCredentialStubs(
      [
        { containerPath: "/home/node", content: "home-root" },
        { containerPath: "/home/nodeXYZ", content: "prefix-trap" },
      ],
      { homeDir },
    );
    expect(existsSync(path.join(homeDir, "home-root"))).toBe(false);
    expect(existsSync(path.join(homeDir, "nodeXYZ"))).toBe(false);
  });

  it("skips credential stubs when none provided", () => {
    dir = mkdtempSync(path.join(tmpdir(), "process-onecli-"));
    expect(() =>
      materializeCredentialStubs(undefined, { homeDir: dir }),
    ).not.toThrow();
    expect(() =>
      materializeCredentialStubs([], { homeDir: dir }),
    ).not.toThrow();
  });
});

describe("buildCombinedCaBundlePem", () => {
  it("returns null when no system CA store is readable", () => {
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    try {
      expect(
        buildCombinedCaBundlePem(
          "-----BEGIN CERTIFICATE-----\nG\n-----END CERTIFICATE-----\n",
        ),
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("rewriteDockerInternalHostnames", () => {
  it("leaves unrelated env values alone", () => {
    const env = { FOO: "bar", HTTPS_PROXY: "http://127.0.0.1:1" };
    rewriteDockerInternalHostnames(env);
    expect(env).toEqual({ FOO: "bar", HTTPS_PROXY: "http://127.0.0.1:1" });
  });
});
