import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  chmodSync,
} from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./process-onecli.js", () => ({
  applyProcessEnv: vi.fn(async () => ({
    ok: true,
    env: { HTTPS_PROXY: "http://127.0.0.1:10255" },
  })),
}));

vi.mock("./log.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./config.js", () => ({
  GROUPS_DIR: "/tmp/nanoclaw-groups-fixture",
  DATA_DIR: "/tmp/nanoclaw-data-fixture",
}));

vi.mock("./db/agent-groups.js", () => ({
  getAgentGroup: vi.fn((id: string) =>
    id === "missing-group" ? undefined : { id, name: id, folder: id },
  ),
}));

vi.mock("./session-manager.js", () => ({
  sessionDir: (agentGroupId: string, sessionId: string) =>
    `/tmp/sessions/${agentGroupId}/${sessionId}`,
  heartbeatPath: (agentGroupId: string, sessionId: string) =>
    `/tmp/sessions/${agentGroupId}/${sessionId}/.heartbeat`,
  markContainerRunning: vi.fn(),
  markContainerStopped: vi.fn(),
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import { applyProcessEnv } from "./process-onecli.js";
import { getAgentGroup } from "./db/agent-groups.js";
import { log } from "./log.js";
import {
  markContainerRunning,
  markContainerStopped,
} from "./session-manager.js";
import {
  augmentHostToolPath,
  buildProcessAgentEnv,
  cleanupProcessOrphans,
  ensureAgentSymlink,
  ensureCodexApiKeyAuthStub,
  ensureCodexFileCredentialsStore,
  ensureProcessProviderHomes,
  isPidAlive,
  isProcessRunning,
  isProcessRuntimeAllowed,
  killTracked,
  pickAllowedHostEnv,
  pidFilePath,
  processDriver,
  readPidFile,
  resetProcessDriverStateForTests,
  resolveWakePaths,
  rewriteSessionioBaseUrlForHost,
  scrubAgentLogLine,
  wakeBlockedPath,
  wakeProcess,
  writePidFile,
  KILL_GRACE_MS,
  WAKE_FAIL_BLOCK_AFTER,
} from "./process-runtime.js";

function makeChild(pid: number | undefined): EventEmitter & {
  pid: number | undefined;
  stderr: EventEmitter;
  stdout: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

describe("process-runtime", () => {
  let root: string;
  let sessionDir: string;
  let groupDir: string;
  let runnerEntry: string;
  const prevPathPrefix = process.env.NANOCLAW_PROCESS_PATH_PREFIX;
  const prevBunBin = process.env.NANOCLAW_BUN_BIN;
  const prevAllow = process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME;

  beforeEach(() => {
    resetProcessDriverStateForTests();
    spawnMock.mockReset();
    process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME = "1";
    vi.mocked(applyProcessEnv).mockResolvedValue({
      ok: true,
      env: { HTTPS_PROXY: "http://127.0.0.1:10255" },
    });
    root = mkdtempSync(path.join(tmpdir(), "process-rt-"));
    sessionDir = path.join(root, "sessions", "ag", "sess-1");
    groupDir = path.join(root, "groups", "ag");
    runnerEntry = path.join(root, "runner", "index.ts");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(groupDir, { recursive: true });
    mkdirSync(path.dirname(runnerEntry), { recursive: true });
    writeFileSync(runnerEntry, 'console.log("hi")');
  });

  afterEach(() => {
    resetProcessDriverStateForTests();
    rmSync(root, { recursive: true, force: true });
    rmSync("/tmp/nanoclaw-data-fixture", { recursive: true, force: true });
    rmSync("/tmp/sessions", { recursive: true, force: true });
    if (prevPathPrefix === undefined)
      delete process.env.NANOCLAW_PROCESS_PATH_PREFIX;
    else process.env.NANOCLAW_PROCESS_PATH_PREFIX = prevPathPrefix;
    if (prevBunBin === undefined) delete process.env.NANOCLAW_BUN_BIN;
    else process.env.NANOCLAW_BUN_BIN = prevBunBin;
    if (prevAllow === undefined)
      delete process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME;
    else process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME = prevAllow;
  });

  it("rewrites sessionio base URL for host process agents", () => {
    expect(
      rewriteSessionioBaseUrlForHost("http://host.docker.internal:18765"),
    ).toBe("http://127.0.0.1:18765");
    expect(rewriteSessionioBaseUrlForHost("http://host.docker.internal/")).toBe(
      "http://127.0.0.1",
    );
    expect(
      rewriteSessionioBaseUrlForHost("http://host.docker.internal/path/"),
    ).toBe("http://127.0.0.1/path/");
    expect(rewriteSessionioBaseUrlForHost("not a url")).toBe("not a url");
    expect(
      buildProcessAgentEnv(
        { id: "sess-1", agent_group_id: "ag-1" },
        "/tmp/sess",
        {
          SESSIONIO_TRANSPORT: "loopback",
          SESSIONIO_BASE_URL: "http://host.docker.internal:18765",
          SESSIONIO_HTTP_TOKEN: "tok",
        },
      ),
    ).toMatchObject({
      WORKING_ROOT: "/tmp/sess",
      SESSIONIO_SESSION_ID: "sess-1",
      SESSIONIO_AGENT_GROUP_ID: "ag-1",
      SESSIONIO_BASE_URL: "http://127.0.0.1:18765",
      SESSIONIO_HTTP_TOKEN: "tok",
    });
  });

  it("injects sessionio for http transport and merges NO_PROXY", () => {
    const env = buildProcessAgentEnv(
      { id: "sess-1", agent_group_id: "ag-1" },
      "/tmp/sess",
      {
        SESSIONIO_TRANSPORT: "HTTP",
        SESSIONIO_BASE_URL: "http://127.0.0.1:9",
        NO_PROXY: "example.com",
        no_proxy: "other.com",
      },
    );
    expect(env.SESSIONIO_TRANSPORT).toBe("HTTP");
    expect(env.NO_PROXY).toContain("example.com");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.no_proxy).toContain("other.com");
  });

  it("skips sessionio session/group injection for filesystem transport", () => {
    const env = buildProcessAgentEnv(
      { id: "sess-1", agent_group_id: "ag-1" },
      "/tmp/sess",
      { SESSIONIO_TRANSPORT: "filesystem", SESSIONIO_HTTP_TOKEN: "tok" },
    );
    // Token remains from allowlisted SESSIONIO_* host env; session/group ids are process-only.
    expect(env.SESSIONIO_SESSION_ID).toBeUndefined();
    expect(env.SESSIONIO_AGENT_GROUP_ID).toBeUndefined();
  });

  it("allowlists host env and never forwards ONECLI_* or SSH_AUTH_SOCK", () => {
    const env = buildProcessAgentEnv(
      { id: "sess-1", agent_group_id: "ag-1" },
      "/tmp/sess",
      {
        PATH: "/usr/bin",
        TERM: "xterm",
        ONECLI_API_KEY: "host-secret",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        AWS_SECRET_ACCESS_KEY: "aws",
        SESSIONIO_HTTP_TOKEN: "tok",
        NANOCLAW_ALLOW_PROCESS_RUNTIME: "1",
      },
      {
        additions: {
          HOME: "/tmp/agent-home",
          PATH: "/custom/bin:/usr/bin",
          HTTPS_PROXY: "http://u:p@127.0.0.1:9",
          ONECLI_API_KEY: "should-not-pass",
          SESSIONIO_BASE_URL: "http://127.0.0.1:9",
          NANOCLAW_PROCESS_PATH_PREFIX: "/opt/extra",
          SKIP_ME: "no",
          // non-string values are ignored
          BAD: 1 as unknown as string,
        },
      },
    );
    expect(env.PATH).toContain("/custom/bin");
    expect(env.TERM).toBe("xterm");
    expect(env.SESSIONIO_HTTP_TOKEN).toBe("tok");
    expect(env.SESSIONIO_BASE_URL).toBe("http://127.0.0.1:9");
    expect(env.NANOCLAW_ALLOW_PROCESS_RUNTIME).toBe("1");
    expect(env.NANOCLAW_PROCESS_PATH_PREFIX).toBe("/opt/extra");
    expect(env.HOME).toBe("/tmp/agent-home");
    expect(env.HTTPS_PROXY).toBe("http://u:p@127.0.0.1:9");
    expect(env.ONECLI_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SKIP_ME).toBeUndefined();
    expect(pickAllowedHostEnv({ ONECLI_URL: "x", PATH: "/bin" })).toEqual({
      PATH: "/bin",
    });
    expect(
      pickAllowedHostEnv({ PATH: undefined, TERM: "x" } as NodeJS.ProcessEnv),
    ).toEqual({ TERM: "x" });
  });

  it("scrubs proxy credentials and token-shaped substrings from log lines", () => {
    expect(
      scrubAgentLogLine("proxy http://user:secret@127.0.0.1:8080 failed"),
    ).toContain("http://***:***@127.0.0.1:8080");
    expect(scrubAgentLogLine("Authorization: Bearer abc.def-ghi")).toContain(
      "Bearer ***",
    );
    expect(scrubAgentLogLine("HTTPS_PROXY=http://x")).toContain(
      "HTTPS_PROXY=***",
    );
    expect(scrubAgentLogLine("ONECLI_API_KEY=supersecret")).toContain(
      "ONECLI_API_KEY=***",
    );
  });

  it("augments PATH with common host tool dirs that exist", () => {
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".bun/bin"), { recursive: true });
    mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    const env = buildProcessAgentEnv(
      { id: "sess-1", agent_group_id: "ag-1" },
      "/tmp/sess",
      { PATH: "/usr/bin:/bin" },
      { pathHome: home },
    );
    expect(env.PATH).toContain(path.join(home, ".bun/bin"));
    expect(env.PATH).toContain(path.join(home, ".local/bin"));
    // /opt/homebrew/bin is macOS-only; /usr/local/bin is often present on Linux CI.
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      try {
        if (fs.statSync(dir).isDirectory()) {
          expect(env.PATH).toContain(dir);
        }
      } catch {
        // absent on this runner
      }
    }
    expect(
      env.PATH!.endsWith("/usr/bin:/bin") ||
        env.PATH!.includes(":/usr/bin:/bin"),
    ).toBe(true);
  });

  it("honors NANOCLAW_PROCESS_PATH_PREFIX for tool discovery", () => {
    const extra = path.join(root, "tools-bin");
    mkdirSync(extra, { recursive: true });
    process.env.NANOCLAW_PROCESS_PATH_PREFIX = `${extra}${path.delimiter}/missing-skip`;
    const result = augmentHostToolPath("/usr/bin", process.env.HOME);
    expect(result.startsWith(extra)).toBe(true);
  });

  it("wakeProcess resolves paths from host modules when ctx is empty", async () => {
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    mkdirSync(path.join(root, "container/agent-runner/src"), {
      recursive: true,
    });
    const defaultRunner = path.join(
      root,
      "container/agent-runner/src/index.ts",
    );
    writeFileSync(defaultRunner, 'console.log("hi")');
    const prev = process.cwd();
    process.chdir(root);
    try {
      const ok = await wakeProcess(
        { id: "sess-empty", agent_group_id: "ag" },
        {},
      );
      expect(ok).toBe(true);
      expect(spawnMock).toHaveBeenCalled();
      const opts = spawnMock.mock.calls[0]![2] as {
        env: { WORKING_ROOT: string };
      };
      expect(opts.env.WORKING_ROOT).toContain("sess-empty");
    } finally {
      process.chdir(prev);
    }
  });

  it("resolveWakePaths returns null when agent group is missing", () => {
    expect(
      resolveWakePaths({ id: "s", agent_group_id: "missing-group" }, {}),
    ).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it("wakeProcess returns false when resolveWakePaths fails", async () => {
    expect(
      await wakeProcess({ id: "s", agent_group_id: "missing-group" }, {}),
    ).toBe(false);
  });

  it("resolveWakePaths uses default lifecycle hooks when ctx omits them", () => {
    const markStopped = vi.fn();
    const resolved = resolveWakePaths(
      { id: "sess-hooks", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        markStopped,
      },
    );
    expect(resolved).not.toBeNull();
    mkdirSync(path.dirname(`/tmp/sessions/ag/sess-hooks/.heartbeat`), {
      recursive: true,
    });
    writeFileSync(`/tmp/sessions/ag/sess-hooks/.heartbeat`, "1");
    resolved!.clearHeartbeat();
    resolved!.markRunning();
    resolved!.markStopped();
    expect(markContainerRunning).toHaveBeenCalledWith("sess-hooks");
    expect(markStopped).toHaveBeenCalled();
  });

  it("resolveWakePaths empty ctx exposes default markStopped", () => {
    const resolved = resolveWakePaths(
      { id: "sess-default-hooks", agent_group_id: "ag" },
      {},
    );
    expect(resolved).not.toBeNull();
    resolved!.markStopped();
    expect(markContainerStopped).toHaveBeenCalledWith("sess-default-hooks");
  });

  it("ensureAgentSymlink creates agent → groupDir link", () => {
    ensureAgentSymlink(sessionDir, groupDir);
    expect(existsSync(path.join(sessionDir, "agent"))).toBe(true);
  });

  it("ensureAgentSymlink is idempotent when link already correct", () => {
    ensureAgentSymlink(sessionDir, groupDir);
    ensureAgentSymlink(sessionDir, groupDir);
    expect(existsSync(path.join(sessionDir, "agent"))).toBe(true);
  });

  it("ensureAgentSymlink replaces empty Docker mountpoint dir", () => {
    mkdirSync(path.join(sessionDir, "agent"), { recursive: true });
    ensureAgentSymlink(sessionDir, groupDir);
    expect(lstatSync(path.join(sessionDir, "agent")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("ensureAgentSymlink refuses non-empty agent directory", () => {
    const agentDir = path.join(sessionDir, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "keep.txt"), "x");
    ensureAgentSymlink(sessionDir, groupDir);
    expect(existsSync(path.join(agentDir, "keep.txt"))).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  it("ensureAgentSymlink replaces a non-directory file", () => {
    writeFileSync(path.join(sessionDir, "agent"), "file");
    ensureAgentSymlink(sessionDir, groupDir);
    expect(lstatSync(path.join(sessionDir, "agent")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("isolates HOME/CODEX_HOME and writes Codex API-key auth stub", () => {
    const runtimeDir = path.join(sessionDir, ".process-runtime");
    const homes = ensureProcessProviderHomes(
      { id: "sess-1", agent_group_id: "ag" },
      runtimeDir,
    );
    expect(homes.home).toBe(path.join(runtimeDir, "home"));
    expect(readlinkSync(path.join(homes.home, ".codex"))).toBe(homes.codexHome);
    expect(
      readFileSync(path.join(homes.codexHome, "auth.json"), "utf8"),
    ).toContain('"auth_mode": "apikey"');
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).toContain('cli_auth_credentials_store = "file"');
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).toContain('mcp_oauth_credentials_store = "file"');

    // Idempotent when symlinks already point at the shared dirs.
    ensureProcessProviderHomes(
      { id: "sess-1", agent_group_id: "ag" },
      runtimeDir,
    );

    // Keep OneCLI stub content when already present.
    writeFileSync(
      path.join(homes.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "from-stub",
      }),
    );
    ensureCodexApiKeyAuthStub(homes.codexHome);
    expect(
      readFileSync(path.join(homes.codexHome, "auth.json"), "utf8"),
    ).toContain("from-stub");

    // Replace empty / legacy auth.
    writeFileSync(path.join(homes.codexHome, "auth.json"), "{}\n");
    ensureCodexApiKeyAuthStub(homes.codexHome);
    expect(
      readFileSync(path.join(homes.codexHome, "auth.json"), "utf8"),
    ).toContain("placeholder");

    // Force file-backed credentials store (replaces keyring/auto).
    writeFileSync(
      path.join(homes.codexHome, "config.toml"),
      [
        'cli_auth_credentials_store = "keyring"',
        'mcp_oauth_credentials_store = "keyring"',
        "[features]",
        "memories = false",
        'sandbox_mode = "danger-full-access"',
        "",
      ].join("\n"),
    );
    ensureCodexFileCredentialsStore(homes.codexHome);
    const afterReplace = readFileSync(
      path.join(homes.codexHome, "config.toml"),
      "utf8",
    );
    expect(afterReplace).toContain('cli_auth_credentials_store = "file"');
    expect(afterReplace).toContain('mcp_oauth_credentials_store = "file"');
    expect(afterReplace).toContain("secret_auth_storage = false");
    expect(afterReplace).toContain('sandbox_mode = "danger-full-access"');

    // Replace an existing secret_auth_storage = true under [features].
    writeFileSync(
      path.join(homes.codexHome, "config.toml"),
      [
        'cli_auth_credentials_store = "file"',
        'mcp_oauth_credentials_store = "file"',
        "[features]",
        "secret_auth_storage = true",
        "memories = false",
        "",
      ].join("\n"),
    );
    ensureCodexFileCredentialsStore(homes.codexHome);
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).toContain("secret_auth_storage = false");
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).not.toContain("secret_auth_storage = true");

    // Already-correct file without trailing newline still normalizes.
    writeFileSync(
      path.join(homes.codexHome, "config.toml"),
      'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"',
    );
    ensureCodexFileCredentialsStore(homes.codexHome);
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8").endsWith(
        "\n",
      ),
    ).toBe(true);

    writeFileSync(
      path.join(homes.codexHome, "config.toml"),
      'sandbox_mode = "danger-full-access"\n',
    );
    ensureCodexFileCredentialsStore(homes.codexHome);
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).toMatch(/cli_auth_credentials_store = "file"/);
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).toMatch(/mcp_oauth_credentials_store = "file"/);

    // Idempotent when already file; empty config still gets the keys.
    ensureCodexFileCredentialsStore(homes.codexHome);
    writeFileSync(path.join(homes.codexHome, "config.toml"), "");
    ensureCodexFileCredentialsStore(homes.codexHome);
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).toContain('cli_auth_credentials_store = "file"');
    expect(
      readFileSync(path.join(homes.codexHome, "config.toml"), "utf8"),
    ).toContain('mcp_oauth_credentials_store = "file"');

    // Replace wrong symlink / non-symlink under synthetic HOME.
    rmSync(path.join(homes.home, ".claude"), { force: true });
    symlinkSync(
      path.join(root, "wrong"),
      path.join(homes.home, ".claude"),
      "dir",
    );
    rmSync(path.join(homes.home, ".codex"), { force: true });
    writeFileSync(path.join(homes.home, ".codex"), "not-a-dir");
    ensureProcessProviderHomes(
      { id: "sess-1", agent_group_id: "ag" },
      runtimeDir,
    );
    expect(lstatSync(path.join(homes.home, ".codex")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("wakeProcess spawns bun with WORKING_ROOT and tracks pid", async () => {
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    const markRunning = vi.fn();
    const clearHeartbeat = vi.fn();

    const ok = await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
        markRunning,
        clearHeartbeat,
      },
    );

    expect(ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, args, opts] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("bun");
    expect(args).toEqual(["run", runnerEntry]);
    expect(opts.cwd).toBe(groupDir);
    expect(opts.env.WORKING_ROOT).toBe(sessionDir);
    expect(opts.env.HTTPS_PROXY).toBe("http://127.0.0.1:10255");
    expect(opts.env.HOME).toBe(
      path.join(sessionDir, ".process-runtime", "home"),
    );
    expect(opts.env.CODEX_HOME).toContain(path.join(".codex-shared"));
    expect(opts.detached).toBe(process.platform !== "win32");
    expect(opts.env.ONECLI_API_KEY).toBeUndefined();
    expect(existsSync(path.join(opts.env.CODEX_HOME!, "auth.json"))).toBe(true);
    expect(
      readFileSync(path.join(opts.env.CODEX_HOME!, "auth.json"), "utf8"),
    ).toContain('"auth_mode": "apikey"');
    expect(readPidFile(sessionDir)).toBe(process.pid);
    expect(markRunning).toHaveBeenCalled();
    expect(clearHeartbeat).toHaveBeenCalled();
    expect(isProcessRunning("sess-1")).toBe(true);

    expect(
      await wakeProcess(
        { id: "sess-1", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          agentGroupName: "Agent",
          agentIdentifier: "ag",
        },
      ),
    ).toBe(true);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("wakeProcess returns false when OneCLI fails", async () => {
    vi.mocked(applyProcessEnv).mockResolvedValue({ ok: false, env: {} });
    const ok = await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
      },
    );
    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("wakeProcess returns false when runner entry missing", async () => {
    const ok = await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: path.join(root, "missing.ts"),
        agentGroupName: "Agent",
        agentIdentifier: "ag",
      },
    );
    expect(ok).toBe(false);
  });

  it("wakeProcess returns false when spawn yields no pid", async () => {
    spawnMock.mockReturnValue(makeChild(undefined));
    const ok = await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    expect(ok).toBe(false);
  });

  it("wakeProcess returns false when applyProcessEnv throws", async () => {
    vi.mocked(applyProcessEnv).mockRejectedValue(new Error("boom"));
    const ok = await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    expect(ok).toBe(false);
  });

  it("wakeProcess logs scrubbed stderr and non-zero exit", async () => {
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    const lines = Array.from({ length: 12 }, (_, i) => `err-line-${i}`).join(
      "\n",
    );
    child.stderr.emit(
      "data",
      Buffer.from(
        `${lines}\n\nextra-after-blank\nHTTPS_PROXY=http://u:p@127.0.0.1:9\n`,
      ),
    );
    child.stdout.emit("data", Buffer.from("out"));
    child.emit("close", 1);
    expect(log.warn).toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("HTTPS_PROXY=***"),
      expect.any(Object),
    );
    expect(isProcessRunning("sess-1")).toBe(false);
  });

  it("wakeProcess tolerates missing stderr/stdout streams", async () => {
    const child = makeChild(process.pid);
    // Optional chaining on pipe streams when spawn omits them.
    (child as { stderr: EventEmitter | undefined }).stderr = undefined;
    (child as { stdout: EventEmitter | undefined }).stdout = undefined;
    spawnMock.mockReturnValue(child);
    const ok = await wakeProcess(
      { id: "sess-nostdio", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    expect(ok).toBe(true);
    child.emit("close", 0);
  });

  it("wakeProcess handles spawn error events", async () => {
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    await wakeProcess(
      { id: "sess-err", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    child.emit("error", new Error("spawn fail"));
    expect(log.error).toHaveBeenCalled();
    expect(isProcessRunning("sess-err")).toBe(false);
  });

  it("killTracked sends SIGTERM then SIGKILL when still alive", async () => {
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const onExit = vi.fn();
    killTracked("sess-1", "idle", onExit, 5);
    await new Promise((r) => setTimeout(r, 20));
    const termPid = process.platform === "win32" ? process.pid : -process.pid;
    expect(killSpy).toHaveBeenCalledWith(termPid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(termPid, "SIGKILL");
    expect(isProcessRunning("sess-1")).toBe(false);
    child.emit("close", 0);
    expect(onExit).toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("wakeProcess waits out an in-flight kill before re-spawning", async () => {
    const first = makeChild(111_222);
    spawnMock.mockReturnValueOnce(first);
    await wakeProcess(
      { id: "sess-killwake", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    let alive = true;
    let signalCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (Math.abs(pid) !== 111_222) return true;
      if (signal === 0 || signal === undefined) {
        if (!alive) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      }
      signalCount += 1;
      // Stay alive for one isPidAlive poll so waitForPidExit's loop body runs.
      if (signalCount >= 2) alive = false;
      return true;
    }) as typeof process.kill);
    killTracked("sess-killwake", "replace", undefined, 5);
    expect(isProcessRunning("sess-killwake")).toBe(false);

    const second = makeChild(333_444);
    spawnMock.mockReturnValueOnce(second);
    const ok = await wakeProcess(
      { id: "sess-killwake", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    expect(ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    killSpy.mockRestore();
  });

  it("wakeProcess refuses re-wake when kill-in-flight pid stays alive", async () => {
    const first = makeChild(555_666);
    spawnMock.mockReturnValueOnce(first);
    await wakeProcess(
      { id: "sess-stuckkill", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (Math.abs(pid) !== 555_666) return true;
      // Always "alive" for signal 0; accept terminate signals but never die.
      if (signal === 0 || signal === undefined) return true;
      return true;
    }) as typeof process.kill);
    killTracked("sess-stuckkill", "replace", undefined, 5);
    expect(isProcessRunning("sess-stuckkill")).toBe(false);

    vi.useFakeTimers();
    try {
      const wakePromise = wakeProcess(
        { id: "sess-stuckkill", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          agentGroupName: "Agent",
          agentIdentifier: "ag",
          bunBinary: "bun",
        },
      );
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 600);
      const ok = await wakePromise;
      expect(ok).toBe(false);
      // Still tracked — do not clear pidfile / allow a concurrent spawn.
      expect(isProcessRunning("sess-stuckkill")).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("still alive after kill wait"),
        expect.objectContaining({ sessionId: "sess-stuckkill", pid: 555_666 }),
      );
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });

  it("isProcessRunning uses stored markStopped when self-healing", async () => {
    const child = makeChild(2_147_483_646);
    spawnMock.mockReturnValue(child);
    const markStopped = vi.fn();
    await wakeProcess(
      { id: "sess-heal", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        bunBinary: "bun",
        markStopped,
      },
    );
    // Drop the pid so the next poll self-heals via entry.markStopped.
    child.pid = 2_147_483_646;
    expect(isProcessRunning("sess-heal")).toBe(false);
    expect(markStopped).toHaveBeenCalled();
  });

  it("killTracked is a no-op when not running", () => {
    expect(() => processDriver.kill("missing", "x")).not.toThrow();
  });

  it("terminatePid swallows ESRCH", async () => {
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    await wakeProcess(
      { id: "sess-1", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
      },
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(() => killTracked("sess-1", "gone", undefined, 1)).not.toThrow();
    killSpy.mockRestore();
  });

  it("terminatePid falls back to direct pid when process-group kill fails", async () => {
    const child = makeChild(777_888);
    spawnMock.mockReturnValue(child);
    await wakeProcess(
      { id: "sess-pg", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        bunBinary: "bun",
      },
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === -777_888) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      if (pid === 777_888 && (signal === 0 || signal === undefined))
        return true;
      return true;
    }) as typeof process.kill);
    expect(() =>
      killTracked("sess-pg", "pg-fallback", undefined, 1),
    ).not.toThrow();
    expect(killSpy).toHaveBeenCalledWith(-777_888, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(777_888, "SIGTERM");
    killSpy.mockRestore();
  });

  it("terminatePid uses direct pid signaling on win32", async () => {
    const child = makeChild(666_555);
    spawnMock.mockReturnValue(child);
    await wakeProcess(
      { id: "sess-win", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        bunBinary: "bun",
      },
    );
    const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      killTracked("sess-win", "win", undefined, 1);
      expect(killSpy).toHaveBeenCalledWith(666_555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-666_555, "SIGTERM");
    } finally {
      killSpy.mockRestore();
      if (platformDesc)
        Object.defineProperty(process, "platform", platformDesc);
    }
  });

  it("isProcessRunning forgets dead tracked pids and calls markStopped", async () => {
    const child = makeChild(2_147_483_647);
    spawnMock.mockReturnValue(child);
    const markStopped = vi.fn();
    await wakeProcess(
      { id: "sess-dead", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
        bunBinary: "bun",
        markStopped,
      },
    );
    expect(isProcessRunning("sess-dead")).toBe(false);
    expect(markStopped).toHaveBeenCalled();
  });

  it("cleanupProcessOrphans reaps dead pidfiles", () => {
    const sessionsRoot = path.join(root, "v2-sessions");
    const orphanSession = path.join(sessionsRoot, "ag", "old");
    const emptySession = path.join(sessionsRoot, "ag", "empty");
    mkdirSync(orphanSession, { recursive: true });
    mkdirSync(emptySession, { recursive: true });
    writePidFile(orphanSession, 1);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    cleanupProcessOrphans(sessionsRoot);
    expect(existsSync(pidFilePath(orphanSession))).toBe(false);
    killSpy.mockRestore();
  });

  it("cleanupProcessOrphans SIGTERMs live orphans then SIGKILLs", async () => {
    const sessionsRoot = path.join(root, "v2-sessions");
    const orphanSession = path.join(sessionsRoot, "ag", "live");
    mkdirSync(orphanSession, { recursive: true });
    const orphanPid = 515_151;
    writePidFile(orphanSession, orphanPid);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === orphanPid) return true;
      return true;
    }) as typeof process.kill);
    cleanupProcessOrphans(sessionsRoot);
    const termPid = process.platform === "win32" ? orphanPid : -orphanPid;
    expect(killSpy).toHaveBeenCalledWith(termPid, "SIGTERM");
    await new Promise((r) => setTimeout(r, KILL_GRACE_MS + 20));
    expect(killSpy).toHaveBeenCalledWith(termPid, "SIGKILL");
    killSpy.mockRestore();
  });

  it("cleanupProcessOrphans discovers default sessions root under cwd", () => {
    const prev = process.cwd();
    process.chdir(root);
    try {
      const sessionsRoot = path.join(root, "data/v2-sessions/ag/sess");
      mkdirSync(sessionsRoot, { recursive: true });
      writePidFile(sessionsRoot, 1);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      processDriver.cleanupOrphans?.();
      expect(existsSync(pidFilePath(sessionsRoot))).toBe(false);
      killSpy.mockRestore();
    } finally {
      process.chdir(prev);
    }
  });

  it("cleanupProcessOrphans falls back to data/sessions", () => {
    const prev = process.cwd();
    process.chdir(root);
    try {
      const sessionsRoot = path.join(root, "data/sessions/ag/sess");
      mkdirSync(sessionsRoot, { recursive: true });
      writePidFile(sessionsRoot, 1);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      cleanupProcessOrphans();
      expect(existsSync(pidFilePath(sessionsRoot))).toBe(false);
      killSpy.mockRestore();
    } finally {
      process.chdir(prev);
    }
  });

  it("cleanupProcessOrphans no-ops when default sessions roots are absent", () => {
    const prev = process.cwd();
    const empty = mkdtempSync(path.join(tmpdir(), "ahp-nosess-"));
    process.chdir(empty);
    try {
      expect(() => cleanupProcessOrphans()).not.toThrow();
    } finally {
      process.chdir(prev);
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("cleanupProcessOrphans no-ops when sessions root missing", () => {
    expect(() =>
      cleanupProcessOrphans(path.join(root, "no-such-sessions")),
    ).not.toThrow();
  });

  it("resolves bun from HOME/.bun/bin when executable", async () => {
    const bunDir = path.join(root, ".bun/bin");
    mkdirSync(bunDir, { recursive: true });
    const bunPath = path.join(bunDir, "bun");
    writeFileSync(bunPath, "#!/bin/sh\n");
    chmodSync(bunPath, 0o755);
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    delete process.env.NANOCLAW_BUN_BIN;
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    try {
      await wakeProcess(
        { id: "sess-home-bun", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          agentGroupName: "Agent",
          agentIdentifier: "ag",
        },
      );
      expect(spawnMock.mock.calls[0]![0]).toBe(bunPath);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("falls back to bun on PATH when no executable candidates exist", async () => {
    const prevHome = process.env.HOME;
    delete process.env.HOME;
    delete process.env.NANOCLAW_BUN_BIN;
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    try {
      await wakeProcess(
        { id: "sess-bun-fallback", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          agentGroupName: "Agent",
          agentIdentifier: "ag",
        },
      );
      expect(spawnMock.mock.calls[0]![0]).toBe("bun");
    } finally {
      accessSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("readPidFile returns null for missing/invalid files", () => {
    expect(readPidFile(path.join(root, "empty"))).toBeNull();
    mkdirSync(path.join(root, "empty"), { recursive: true });
    writeFileSync(pidFilePath(path.join(root, "empty")), "nope\n");
    expect(readPidFile(path.join(root, "empty"))).toBeNull();
  });

  it("uses NANOCLAW_BUN_BIN when set", async () => {
    process.env.NANOCLAW_BUN_BIN = "/custom/bun";
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    await wakeProcess(
      { id: "sess-bun", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        agentGroupName: "Agent",
        agentIdentifier: "ag",
      },
    );
    expect(spawnMock.mock.calls[0]![0]).toBe("/custom/bun");
  });

  it("isPidAlive returns boolean", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });

  it("isPidAlive treats EPERM as alive", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    try {
      expect(isPidAlive(12345)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("exports KILL_GRACE_MS", () => {
    expect(KILL_GRACE_MS).toBeGreaterThan(0);
  });

  it("replaces incorrect agent symlink", () => {
    const wrong = path.join(root, "wrong-group");
    mkdirSync(wrong, { recursive: true });
    symlinkSync(wrong, path.join(sessionDir, "agent"), "dir");
    ensureAgentSymlink(sessionDir, groupDir);
    expect(existsSync(path.join(sessionDir, "agent"))).toBe(true);
  });

  it("PATH augment prefers operator HOME even when child HOME is synthetic", () => {
    const operatorHome = path.join(root, "operator-home");
    mkdirSync(path.join(operatorHome, ".bun/bin"), { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = operatorHome;
    try {
      const env = buildProcessAgentEnv(
        { id: "sess-1", agent_group_id: "ag-1" },
        "/tmp/sess",
        {
          PATH: "/usr/bin",
        },
        {
          pathHome: operatorHome,
          additions: { HOME: path.join(root, "synthetic-home") },
        },
      );
      expect(env.PATH).toContain(path.join(operatorHome, ".bun/bin"));
      expect(env.HOME).toBe(path.join(root, "synthetic-home"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("refuses wake without NANOCLAW_ALLOW_PROCESS_RUNTIME", async () => {
    delete process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME;
    expect(isProcessRuntimeAllowed()).toBe(false);
    const ok = await wakeProcess(
      { id: "sess-deny", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        bunBinary: "bun",
      },
    );
    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("adopts an alive pidfile instead of double-spawning", async () => {
    const orphanPid = 424_242;
    writePidFile(sessionDir, orphanPid);
    let orphanAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (Math.abs(pid) !== orphanPid) return true;
      if (signal === 0 || signal === undefined) {
        if (!orphanAlive) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        // Keep alive so the adopted onExit poll hits the timeout branch.
        return true;
      }
      return true;
    }) as typeof process.kill);
    const markRunning = vi.fn();
    try {
      const ok = await wakeProcess(
        { id: "sess-adopt", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          bunBinary: "bun",
          markRunning,
        },
      );
      expect(ok).toBe(true);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(markRunning).toHaveBeenCalled();
      expect(isProcessRunning("sess-adopt")).toBe(true);

      const onExit = vi.fn();
      vi.useFakeTimers();
      try {
        killTracked("sess-adopt", "test", onExit, 10);
        // Stay alive through the poll until the grace+5s timeout branch fires.
        await vi.advanceTimersByTimeAsync(5_100);
        expect(onExit).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  it("clears pidfiles that match the host pid or are already dead before spawn", async () => {
    writePidFile(sessionDir, process.pid);
    const child = makeChild(process.pid);
    spawnMock.mockReturnValue(child);
    expect(
      await wakeProcess(
        { id: "sess-self-pid", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          bunBinary: "bun",
        },
      ),
    ).toBe(true);
    expect(spawnMock).toHaveBeenCalled();

    spawnMock.mockClear();
    writePidFile(sessionDir, 2_147_483_647);
    const child2 = makeChild(process.pid);
    spawnMock.mockReturnValue(child2);
    expect(
      await wakeProcess(
        { id: "sess-dead-pid", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          bunBinary: "bun",
        },
      ),
    ).toBe(true);
    expect(spawnMock).toHaveBeenCalled();
  });

  it("writes wake-blocked marker after repeated fail-closed wakes", async () => {
    vi.mocked(applyProcessEnv).mockResolvedValue({ ok: false, env: {} });
    for (let i = 0; i < WAKE_FAIL_BLOCK_AFTER; i += 1) {
      await wakeProcess(
        { id: "sess-block", agent_group_id: "ag" },
        {
          sessionDir,
          groupDir,
          agentRunnerEntry: runnerEntry,
          bunBinary: "bun",
        },
      );
    }
    expect(existsSync(wakeBlockedPath(sessionDir))).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });

  it("blocks after repeated allow-env failures without a session dir", async () => {
    delete process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME;
    for (let i = 0; i < WAKE_FAIL_BLOCK_AFTER; i += 1) {
      await wakeProcess({ id: "sess-allow-block", agent_group_id: "ag" }, {});
    }
    expect(log.error).toHaveBeenCalled();
  });

  it("tolerates wake-blocked marker write failures", async () => {
    vi.mocked(applyProcessEnv).mockResolvedValue({ ok: false, env: {} });
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    try {
      for (let i = 0; i < WAKE_FAIL_BLOCK_AFTER; i += 1) {
        await wakeProcess(
          { id: "sess-marker-fail", agent_group_id: "ag" },
          {
            sessionDir,
            groupDir,
            agentRunnerEntry: runnerEntry,
            bunBinary: "bun",
          },
        );
      }
      expect(log.error).toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it("records non-Error wake throws as wake-threw", async () => {
    vi.mocked(applyProcessEnv).mockImplementation(async () => {
      throw "raw-string-failure";
    });
    const ok = await wakeProcess(
      { id: "sess-raw-throw", agent_group_id: "ag" },
      {
        sessionDir,
        groupDir,
        agentRunnerEntry: runnerEntry,
        bunBinary: "bun",
      },
    );
    expect(ok).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it("cleanupProcessOrphans ignores pidfiles that match the host pid", () => {
    const sessionsRoot = path.join(root, "v2-sessions");
    const orphanSession = path.join(sessionsRoot, "ag", "self");
    mkdirSync(orphanSession, { recursive: true });
    writePidFile(orphanSession, process.pid);
    cleanupProcessOrphans(sessionsRoot);
    expect(existsSync(pidFilePath(orphanSession))).toBe(false);
  });
});
