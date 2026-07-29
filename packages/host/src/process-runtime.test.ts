import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
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
  getAgentGroup: vi.fn((id: string) => ({ id, name: id, folder: id })),
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
import {
  buildProcessAgentEnv,
  cleanupProcessOrphans,
  ensureAgentSymlink,
  isPidAlive,
  isProcessRunning,
  killTracked,
  pidFilePath,
  processDriver,
  readPidFile,
  resetProcessDriverStateForTests,
  rewriteSessionioBaseUrlForHost,
  wakeProcess,
  writePidFile,
  KILL_GRACE_MS,
} from "./process-runtime.js";

function makeChild(pid: number): EventEmitter & {
  pid: number;
  stderr: EventEmitter;
  stdout: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
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

  beforeEach(() => {
    resetProcessDriverStateForTests();
    spawnMock.mockReset();
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
  });

  it("rewrites sessionio base URL for host process agents", () => {
    expect(
      rewriteSessionioBaseUrlForHost(
        "http://host.docker.internal:18765",
      ),
    ).toBe("http://127.0.0.1:18765");
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

  it("augments PATH so LaunchAgent hosts can find Homebrew tools", () => {
    const env = buildProcessAgentEnv(
      { id: "sess-1", agent_group_id: "ag-1" },
      "/tmp/sess",
      { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
    );
    expect(env.PATH).toContain("/opt/homebrew/bin");
    expect(env.PATH!.startsWith("/opt/homebrew/bin") || env.PATH!.includes("/opt/homebrew/bin:")).toBe(
      true,
    );
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

  it("ensureAgentSymlink creates agent → groupDir link", () => {
    ensureAgentSymlink(sessionDir, groupDir);
    expect(existsSync(path.join(sessionDir, "agent"))).toBe(true);
  });

  it("ensureAgentSymlink is idempotent when link already correct", () => {
    ensureAgentSymlink(sessionDir, groupDir);
    ensureAgentSymlink(sessionDir, groupDir);
    expect(existsSync(path.join(sessionDir, "agent"))).toBe(true);
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
    expect(existsSync(path.join(opts.env.CODEX_HOME!, "auth.json"))).toBe(
      true,
    );
    expect(
      readFileSync(path.join(opts.env.CODEX_HOME!, "auth.json"), "utf8"),
    ).toContain('"auth_mode": "apikey"');
    expect(readPidFile(sessionDir)).toBe(process.pid);
    expect(markRunning).toHaveBeenCalled();
    expect(clearHeartbeat).toHaveBeenCalled();
    expect(isProcessRunning("sess-1")).toBe(true);

    // second wake is no-op
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

  it("killTracked sends SIGTERM and clears on close", async () => {
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
      },
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const onExit = vi.fn();
    killTracked("sess-1", "idle", onExit, 10);
    child.emit("close", 0);
    expect(onExit).toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("processDriver.kill is a no-op when not running", () => {
    expect(() => processDriver.kill("missing", "x")).not.toThrow();
  });

  it("cleanupProcessOrphans reaps pidfiles", () => {
    const sessionsRoot = path.join(root, "v2-sessions");
    const orphanSession = path.join(sessionsRoot, "ag", "old");
    mkdirSync(orphanSession, { recursive: true });
    writePidFile(orphanSession, 1);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    cleanupProcessOrphans(sessionsRoot);
    expect(existsSync(pidFilePath(orphanSession))).toBe(false);
    killSpy.mockRestore();
  });

  it("isPidAlive returns boolean", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });

  it("exports KILL_GRACE_MS", () => {
    expect(KILL_GRACE_MS).toBeGreaterThan(0);
  });

  it("replaces incorrect agent symlink", () => {
    const wrong = path.join(root, "wrong-group");
    mkdirSync(wrong, { recursive: true });
    symlinkSync(wrong, path.join(sessionDir, "agent"), "dir");
    ensureAgentSymlink(sessionDir, groupDir);
    expect(readFileSync).toBeTypeOf("function");
    expect(existsSync(path.join(sessionDir, "agent"))).toBe(true);
  });
});
