/**
 * Local child-process RuntimeDriver for nanoclaw-agenthosts.
 *
 * Trades container isolation for host-native capability (tmux, headed browsers,
 * macOS TCC APIs). Prefer Docker / Apple Container for untrusted channel content.
 *
 * agenthosts v1 calls `wake(session, {})` — this driver resolves session/group
 * paths from NanoClaw host modules when WakeContext does not supply them.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { RuntimeDriver, SessionRef, WakeContext } from "./agenthosts.js";
import { DATA_DIR, GROUPS_DIR } from "./config.js";
import { getAgentGroup } from "./db/agent-groups.js";
import { log } from "./log.js";
import { applyProcessEnv } from "./process-onecli.js";
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir as hostSessionDir,
} from "./session-manager.js";

export const PROCESS_PID_FILENAME = ".process.pid";
export const PROCESS_RUNTIME_DIRNAME = ".process-runtime";
export const PROCESS_WAKE_BLOCKED_FILENAME = ".process.wake-blocked";
export const KILL_GRACE_MS = 2_000;
/** Consecutive fail-closed wakes before writing a blocked marker for operators. */
export const WAKE_FAIL_BLOCK_AFTER = 5;

interface TrackedChild {
  process: ChildProcess | null;
  pid: number;
  sessionDir: string;
  markStopped?: () => void;
  /** Set by killTracked so wake does not treat an in-flight kill as "already running". */
  killing?: boolean;
}

/** Host env keys safe to forward into the untrusted agent process (opt-in). */
const ALLOWED_HOST_ENV_KEYS = new Set([
  "PATH",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "USER",
  "LOGNAME",
  "NO_PROXY",
  "no_proxy",
]);

const ALLOWED_HOST_ENV_PREFIXES = ["SESSIONIO_", "NANOCLAW_"];

/** Keys that may be overlaid from OneCLI / driver additions (never taken from host alone). */
const AGENT_SCOPED_ENV_KEYS = new Set([
  "HOME",
  "CODEX_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "DENO_CERT",
  "NODE_USE_ENV_PROXY",
]);

export interface ResolvedWakePaths {
  sessionDir: string;
  groupDir: string;
  agentRunnerEntry: string;
  agentIdentifier: string;
  agentGroupName: string;
  bunBinary: string;
  env?: NodeJS.ProcessEnv;
  clearHeartbeat: () => void;
  markRunning: () => void;
  markStopped: () => void;
}

const activeChildren = new Map<string, TrackedChild>();
const wakeFailures = new Map<string, number>();

/** Host-level opt-in — per-group `runtime=process` alone must not unsandbox. */
export function isProcessRuntimeAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.NANOCLAW_ALLOW_PROCESS_RUNTIME ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function mergeNoProxy(current: string | undefined, extra: string): string {
  const parts = new Set(
    `${current ?? ""},${extra}`
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  return [...parts].join(",");
}

/** Docker agents use host.docker.internal; process agents run on the host. */
export function rewriteSessionioBaseUrlForHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "host.docker.internal") {
      parsed.hostname = "127.0.0.1";
    }
    // URL#toString keeps trailing slash rules; strip only a lone path slash.
    const out = parsed.toString();
    return out.endsWith("/") && parsed.pathname === "/"
      ? out.slice(0, -1)
      : out;
  } catch {
    return url;
  }
}

/**
 * Env for the spawned agent-runner. Starts from an **allowlist** of host vars
 * (not a full `process.env` spread) so operator secrets / SSH agent sockets /
 * host OneCLI keys do not ride into the untrusted child. OneCLI proxy/CA vars
 * and synthetic HOME come from `opts.additions`.
 */
export function buildProcessAgentEnv(
  session: SessionRef,
  sessionDirectory: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  opts?: { pathHome?: string; additions?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
  const pathHome = opts?.pathHome ?? process.env.HOME;
  const env: NodeJS.ProcessEnv = {
    ...pickAllowedHostEnv(hostEnv),
    WORKING_ROOT: sessionDirectory,
  };

  const additions = opts?.additions ?? {};
  for (const [key, value] of Object.entries(additions)) {
    if (typeof value !== "string") continue;
    // Never forward host OneCLI credentials into the agent process.
    if (key.startsWith("ONECLI_")) continue;
    if (
      AGENT_SCOPED_ENV_KEYS.has(key) ||
      key.startsWith("SESSIONIO_") ||
      key.startsWith("NANOCLAW_")
    ) {
      env[key] = value;
    }
  }

  env.PATH = augmentHostToolPath(
    typeof additions.PATH === "string" ? additions.PATH : env.PATH,
    pathHome,
  );

  const transport = (env.SESSIONIO_TRANSPORT ?? "").trim().toLowerCase();
  if (transport === "http" || transport === "loopback") {
    env.SESSIONIO_SESSION_ID = session.id;
    env.SESSIONIO_AGENT_GROUP_ID = session.agent_group_id;
    if (env.SESSIONIO_BASE_URL) {
      env.SESSIONIO_BASE_URL = rewriteSessionioBaseUrlForHost(
        env.SESSIONIO_BASE_URL,
      );
    }
    const noProxyExtra = "127.0.0.1,localhost,host.docker.internal";
    env.NO_PROXY = mergeNoProxy(env.NO_PROXY, noProxyExtra);
    env.no_proxy = mergeNoProxy(env.no_proxy, noProxyExtra);
  }

  return env;
}

/** Pick only explicitly allowlisted host env keys (opt-in, not opt-out). */
export function pickAllowedHostEnv(
  hostEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("ONECLI_")) continue;
    if (
      ALLOWED_HOST_ENV_KEYS.has(key) ||
      ALLOWED_HOST_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      out[key] = value;
    }
  }
  return out;
}

/** Redact proxy credentials / common secrets before agent stderr hits host logs. */
export function scrubAgentLogLine(line: string): string {
  return line
    .replace(/(\w+:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1***:***@")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1***")
    .replace(
      /\b(ONECLI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|SESSIONIO_HTTP_TOKEN|HTTPS_PROXY|HTTP_PROXY|https_proxy|http_proxy|ALL_PROXY|all_proxy)\s*[=:]\s*\S+/gi,
      "$1=***",
    );
}

/**
 * LaunchAgents often ship a minimal PATH (no Homebrew). Provider CLIs like
 * `codex` / `claude` live under /opt/homebrew/bin — prepend common tool dirs.
 */
export function augmentHostToolPath(
  currentPath: string | undefined,
  home: string | undefined = process.env.HOME,
): string {
  const existing = (currentPath ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  const existingSet = new Set(existing);

  const extras: string[] = [];
  const prefix = process.env.NANOCLAW_PROCESS_PATH_PREFIX?.trim();
  if (prefix) {
    for (const part of prefix.split(path.delimiter)) {
      const trimmed = part.trim();
      if (trimmed) extras.push(trimmed);
    }
  }
  if (home) {
    extras.push(path.join(home, ".bun/bin"), path.join(home, ".local/bin"));
  }
  extras.push("/opt/homebrew/bin", "/usr/local/bin");

  const prepend: string[] = [];
  for (const dir of extras) {
    if (existingSet.has(dir) || prepend.includes(dir)) continue;
    try {
      if (fs.statSync(dir).isDirectory()) prepend.push(dir);
    } catch {
      // skip missing dirs
    }
  }
  return [...prepend, ...existing].join(path.delimiter);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveBunBinary(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.NANOCLAW_BUN_BIN) return process.env.NANOCLAW_BUN_BIN;
  const home = process.env.HOME;
  const candidates = [
    home ? path.join(home, ".bun/bin/bun") : "",
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return "bun";
}

export function resolveWakePaths(
  session: SessionRef,
  ctx: WakeContext,
): ResolvedWakePaths | null {
  const ctxSessionDir = asString(ctx.sessionDir);
  const ctxGroupDir = asString(ctx.groupDir);
  const ctxRunner = asString(ctx.agentRunnerEntry);

  if (ctxSessionDir && ctxGroupDir && ctxRunner) {
    return {
      sessionDir: path.resolve(ctxSessionDir),
      groupDir: path.resolve(ctxGroupDir),
      agentRunnerEntry: path.resolve(ctxRunner),
      agentIdentifier: asString(ctx.agentIdentifier) ?? session.agent_group_id,
      agentGroupName: asString(ctx.agentGroupName) ?? session.agent_group_id,
      bunBinary: resolveBunBinary(asString(ctx.bunBinary)),
      env: (ctx.env as NodeJS.ProcessEnv | undefined) ?? undefined,
      clearHeartbeat:
        typeof ctx.clearHeartbeat === "function"
          ? (ctx.clearHeartbeat as () => void)
          : () => {
              fs.rmSync(heartbeatPath(session.agent_group_id, session.id), {
                force: true,
              });
            },
      markRunning:
        typeof ctx.markRunning === "function"
          ? (ctx.markRunning as () => void)
          : () => markContainerRunning(session.id),
      markStopped:
        typeof ctx.markStopped === "function"
          ? (ctx.markStopped as () => void)
          : () => markContainerStopped(session.id),
    };
  }

  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error("Agent group not found for process wake", {
      agentGroupId: session.agent_group_id,
    });
    return null;
  }

  const sessionDirectory = hostSessionDir(session.agent_group_id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const agentRunnerEntry = path.resolve(
    process.cwd(),
    "container/agent-runner/src/index.ts",
  );

  return {
    sessionDir: path.resolve(sessionDirectory),
    groupDir,
    agentRunnerEntry,
    agentIdentifier: agentGroup.id,
    agentGroupName: agentGroup.name,
    bunBinary: resolveBunBinary(),
    clearHeartbeat: () => {
      fs.rmSync(heartbeatPath(session.agent_group_id, session.id), {
        force: true,
      });
    },
    markRunning: () => markContainerRunning(session.id),
    markStopped: () => markContainerStopped(session.id),
  };
}

export function pidFilePath(sessionDirPath: string): string {
  return path.join(sessionDirPath, PROCESS_PID_FILENAME);
}

export function runtimeDirPath(sessionDirPath: string): string {
  return path.join(sessionDirPath, PROCESS_RUNTIME_DIRNAME);
}

/** Per-group Codex state — same host path Docker mounts at /home/node/.codex. */
export function codexSharedDir(agentGroupId: string): string {
  return path.join(DATA_DIR, "v2-sessions", agentGroupId, ".codex-shared");
}

/** Per-group Claude state — same host path Docker mounts at /home/node/.claude. */
export function claudeSharedDir(agentGroupId: string): string {
  return path.join(DATA_DIR, "v2-sessions", agentGroupId, ".claude-shared");
}

function ensureDirSymlink(linkPath: string, target: string): void {
  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath);
      if (
        path.resolve(path.dirname(linkPath), current) === path.resolve(target)
      )
        return;
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  fs.symlinkSync(target, linkPath, "dir");
}

/**
 * Isolate provider state from the host user's $HOME (LaunchAgents inherit the
 * operator HOME). Without this, Codex picks up ChatGPT login from ~/.codex /
 * Keychain and bypasses OneCLI API-key injection on the gateway.
 */
export function ensureProcessProviderHomes(
  session: SessionRef,
  runtimeDir: string,
): { home: string; codexHome: string; claudeHome: string } {
  const home = path.join(runtimeDir, "home");
  fs.mkdirSync(home, { recursive: true });

  const codexHome = codexSharedDir(session.agent_group_id);
  fs.mkdirSync(codexHome, { recursive: true });
  ensureCodexApiKeyAuthStub(codexHome);
  ensureCodexFileCredentialsStore(codexHome);

  const claudeHome = claudeSharedDir(session.agent_group_id);
  fs.mkdirSync(claudeHome, { recursive: true });

  ensureDirSymlink(path.join(home, ".codex"), codexHome);
  ensureDirSymlink(path.join(home, ".claude"), claudeHome);

  return { home, codexHome, claudeHome };
}

/**
 * Force Codex into API-key auth mode with OneCLI's placeholder. An empty
 * auth.json (Docker mountpoint) makes host Codex fall back to ChatGPT/Keychain,
 * which hits chatgpt.com and fails websocket upgrade even through the proxy.
 */
export function ensureCodexApiKeyAuthStub(codexHome: string): void {
  const authPath = path.join(codexHome, "auth.json");
  const sentinel = `${JSON.stringify(
    {
      auth_mode: "apikey",
      OPENAI_API_KEY: "placeholder",
    },
    null,
    2,
  )}\n`;

  let existing = "";
  try {
    existing = fs.readFileSync(authPath, "utf8").trim();
  } catch {
    // create below
  }

  // Keep stub content from OneCLI credentialStubs; only replace empty/legacy.
  if (
    existing &&
    existing.includes('"auth_mode"') &&
    existing.includes("OPENAI_API_KEY")
  ) {
    return;
  }

  fs.writeFileSync(authPath, sentinel, { mode: 0o600 });
}

/**
 * Keep Codex off the OS keyring. Default stores are keyring/auto — on macOS
 * LaunchAgent children that probe Security.framework get a Keychain popup
 * even with an isolated HOME + auth.json apikey stub.
 */
export function ensureCodexFileCredentialsStore(codexHome: string): void {
  const configPath = path.join(codexHome, "config.toml");
  const desiredKeys: Array<{ key: string; line: string }> = [
    {
      key: "cli_auth_credentials_store",
      line: 'cli_auth_credentials_store = "file"',
    },
    {
      key: "mcp_oauth_credentials_store",
      line: 'mcp_oauth_credentials_store = "file"',
    },
  ];

  let existing = "";
  try {
    existing = fs.readFileSync(configPath, "utf8");
  } catch {
    fs.writeFileSync(
      configPath,
      `${desiredKeys.map((k) => k.line).join("\n")}\n`,
      { mode: 0o600 },
    );
    return;
  }

  let next = existing;
  const missing: string[] = [];
  for (const { key, line } of desiredKeys) {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*.*$`, "m");
    if (re.test(next)) {
      next = next.replace(re, line);
    } else {
      missing.push(line);
    }
  }

  // Disable keyring-backed age secrets key when a [features] table exists.
  if (/^\s*\[features\]\s*$/m.test(next)) {
    if (/^\s*secret_auth_storage\s*=/m.test(next)) {
      next = next.replace(
        /^\s*secret_auth_storage\s*=\s*.*$/m,
        "secret_auth_storage = false",
      );
    } else {
      next = next.replace(
        /^(\s*\[features\]\s*)$/m,
        `$1\nsecret_auth_storage = false`,
      );
    }
  }

  if (missing.length) {
    const trimmed = next.trimEnd();
    next = `${trimmed ? `${trimmed}\n` : ""}${missing.join("\n")}\n`;
  } else if (!next.endsWith("\n")) {
    next = `${next}\n`;
  }

  if (next !== existing) fs.writeFileSync(configPath, next, { mode: 0o600 });
}

export function ensureAgentSymlink(
  sessionDirPath: string,
  groupDir: string,
): void {
  const linkPath = path.join(sessionDirPath, "agent");
  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath);
      if (path.resolve(sessionDirPath, current) === path.resolve(groupDir))
        return;
      fs.unlinkSync(linkPath);
    } else if (existing.isDirectory()) {
      // Docker leaves an empty agent/ mount point dir; replace with symlink.
      const entries = fs.readdirSync(linkPath);
      if (entries.length > 0) {
        log.warn(
          "session agent/ exists as a non-empty directory — not replacing with group symlink",
          { linkPath, groupDir },
        );
        return;
      }
      fs.rmdirSync(linkPath);
    } else {
      fs.unlinkSync(linkPath);
    }
  }
  fs.symlinkSync(groupDir, linkPath, "dir");
}

export function wakeBlockedPath(sessionDirPath: string): string {
  return path.join(sessionDirPath, PROCESS_WAKE_BLOCKED_FILENAME);
}

function clearWakeFailure(sessionId: string, sessionDirPath?: string): void {
  wakeFailures.delete(sessionId);
  if (sessionDirPath) {
    fs.rmSync(wakeBlockedPath(sessionDirPath), { force: true });
  }
}

function recordWakeFailure(
  session: SessionRef,
  sessionDirPath: string | undefined,
  reason: string,
): void {
  const count = (wakeFailures.get(session.id) ?? 0) + 1;
  wakeFailures.set(session.id, count);
  if (count < WAKE_FAIL_BLOCK_AFTER) {
    log.warn("Process wake failed — host-sweep will retry", {
      sessionId: session.id,
      reason,
      failures: count,
      blockAfter: WAKE_FAIL_BLOCK_AFTER,
    });
    return;
  }
  if (sessionDirPath) {
    try {
      fs.mkdirSync(sessionDirPath, { recursive: true });
      fs.writeFileSync(
        wakeBlockedPath(sessionDirPath),
        `${JSON.stringify(
          {
            sessionId: session.id,
            agentGroupId: session.agent_group_id,
            reason,
            failures: count,
            at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    } catch {
      // best-effort marker
    }
  }
  log.error(
    "Process wake blocked after repeated failures — fix config or clear .process.wake-blocked",
    {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      reason,
      failures: count,
      marker: sessionDirPath
        ? wakeBlockedPath(sessionDirPath)
        : PROCESS_WAKE_BLOCKED_FILENAME,
    },
  );
}

function adoptExistingPid(
  session: SessionRef,
  sessionDirectory: string,
  markRunning: () => void,
  markStopped: () => void,
): boolean {
  const existingPid = readPidFile(sessionDirectory);
  if (existingPid == null) return false;
  if (existingPid === process.pid) {
    clearPidFile(sessionDirectory);
    return false;
  }
  if (!isPidAlive(existingPid)) {
    clearPidFile(sessionDirectory);
    return false;
  }
  log.info("Adopting existing process agent from pidfile", {
    sessionId: session.id,
    pid: existingPid,
    sessionDir: sessionDirectory,
  });
  activeChildren.set(session.id, {
    process: null,
    pid: existingPid,
    sessionDir: sessionDirectory,
    markStopped,
  });
  markRunning();
  clearWakeFailure(session.id, sessionDirectory);
  return true;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (isPidAlive(pid) && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function writePidFile(sessionDirPath: string, pid: number): void {
  fs.writeFileSync(pidFilePath(sessionDirPath), `${pid}\n`, { mode: 0o600 });
}

export function readPidFile(sessionDirPath: string): number | null {
  const file = pidFilePath(sessionDirPath);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function clearPidFile(sessionDirPath: string): void {
  fs.rmSync(pidFilePath(sessionDirPath), { force: true });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but we lack permission — treat as alive (conservative)
    // so wake/kill gates do not clear tracking and double-spawn.
    return (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

/**
 * Signal a tracked agent pid (and its process group when detached).
 *
 * PID-reuse caveat (accepted for PoC): between isPidAlive and kill, the OS may
 * recycle the pid. We do not fingerprint start-time/comm; Docker avoids this via
 * container handles. Prefer process-group kill so grandchildren die with us.
 */
function terminatePid(
  pid: number,
  signal: NodeJS.Signals,
  processGroup = true,
): void {
  try {
    if (processGroup && process.platform !== "win32") {
      // Negative pid = process group (spawned with detached:true).
      process.kill(-pid, signal);
      return;
    }
    process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export function killTracked(
  sessionId: string,
  reason: string,
  onExit?: () => void,
  graceMs: number = KILL_GRACE_MS,
): void {
  const entry = activeChildren.get(sessionId);
  if (!entry) {
    return;
  }

  entry.killing = true;
  log.info("Killing process agent", { sessionId, reason, pid: entry.pid });

  if (onExit) {
    if (entry.process) {
      entry.process.once("close", onExit);
    } else {
      // Adopted from pidfile — no ChildProcess handle; poll until gone.
      const started = Date.now();
      const poll = setInterval(() => {
        if (!isPidAlive(entry.pid) || Date.now() - started > graceMs + 5_000) {
          clearInterval(poll);
          onExit();
        }
      }, 50);
      poll.unref?.();
    }
  }

  terminatePid(entry.pid, "SIGTERM");
  const timer = setTimeout(() => {
    if (
      activeChildren.get(sessionId)?.pid === entry.pid &&
      isPidAlive(entry.pid)
    ) {
      log.warn("Process agent still alive after SIGTERM — sending SIGKILL", {
        sessionId,
        pid: entry.pid,
      });
      terminatePid(entry.pid, "SIGKILL");
    }
  }, graceMs);
  timer.unref?.();
}

function forgetChild(
  sessionId: string,
  sessionDirPath: string,
  markStopped?: () => void,
): void {
  const entry = activeChildren.get(sessionId);
  activeChildren.delete(sessionId);
  clearPidFile(sessionDirPath);
  (markStopped ?? entry?.markStopped)?.();
}

export async function wakeProcess(
  session: SessionRef,
  ctx: WakeContext,
): Promise<boolean> {
  if (!isProcessRuntimeAllowed()) {
    log.error(
      "Process runtime refused — set NANOCLAW_ALLOW_PROCESS_RUNTIME=1 on the host to opt in",
      { sessionId: session.id, agentGroupId: session.agent_group_id },
    );
    recordWakeFailure(session, undefined, "allow-env-unset");
    return false;
  }

  if (activeChildren.has(session.id)) {
    const existing = activeChildren.get(session.id)!;
    if (existing.killing) {
      // Kill in flight — do not treat as healthy running; wait briefly then re-wake.
      log.debug("Process agent kill in flight — waiting before re-wake", {
        sessionId: session.id,
        pid: existing.pid,
      });
      await waitForPidExit(existing.pid, KILL_GRACE_MS + 500);
      if (isPidAlive(existing.pid)) {
        log.warn(
          "Process agent still alive after kill wait — refusing re-wake to avoid double-spawn",
          { sessionId: session.id, pid: existing.pid },
        );
        recordWakeFailure(session, existing.sessionDir, "kill-still-alive");
        return false;
      }
      forgetChild(session.id, existing.sessionDir, existing.markStopped);
    } else {
      log.debug("Process agent already running", { sessionId: session.id });
      return true;
    }
  }

  const resolved = resolveWakePaths(session, ctx);
  if (!resolved) {
    recordWakeFailure(session, undefined, "resolve-paths-failed");
    return false;
  }

  const {
    sessionDir: sessionDirectory,
    groupDir,
    agentRunnerEntry,
    bunBinary,
    agentIdentifier,
    agentGroupName,
    env: extraEnv,
    clearHeartbeat,
    markRunning,
    markStopped,
  } = resolved;

  if (adoptExistingPid(session, sessionDirectory, markRunning, markStopped)) {
    return true;
  }

  if (!fs.existsSync(agentRunnerEntry)) {
    log.error("Agent runner entry not found", { agentRunnerEntry });
    recordWakeFailure(session, sessionDirectory, "runner-entry-missing");
    return false;
  }

  log.warn(
    "Process runtime: agent runs with host user privileges for configured paths — not a Docker sandbox substitute",
    { sessionId: session.id, agentGroupId: session.agent_group_id },
  );

  try {
    fs.mkdirSync(sessionDirectory, { recursive: true });
    ensureAgentSymlink(sessionDirectory, groupDir);
    clearHeartbeat();

    const runtimeDir = runtimeDirPath(sessionDirectory);
    const homes = ensureProcessProviderHomes(session, runtimeDir);
    const onecli = await applyProcessEnv({
      runtimeDir,
      agentIdentifier,
      agentName: agentGroupName,
      homeDir: homes.home,
      codexHome: homes.codexHome,
    });
    if (!onecli.ok) {
      log.warn(
        "OneCLI gateway not applied — refusing to spawn process agent without credentials",
        {
          sessionId: session.id,
        },
      );
      recordWakeFailure(session, sessionDirectory, "onecli-unavailable");
      return false;
    }

    // Allowlisted host env + OneCLI additions + synthetic provider homes.
    // Does NOT spread full process.env (host OneCLI keys / SSH agent stay out).
    const env = buildProcessAgentEnv(session, sessionDirectory, process.env, {
      pathHome: process.env.HOME,
      additions: {
        ...extraEnv,
        ...onecli.env,
        HOME: homes.home,
        CODEX_HOME: homes.codexHome,
      },
    });

    const child = spawn(bunBinary, ["run", agentRunnerEntry], {
      cwd: groupDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so kill(-pid) reaches grandchildren (tmux, browsers).
      detached: process.platform !== "win32",
    });

    if (child.pid == null) {
      log.error("Process agent spawn returned no pid", {
        sessionId: session.id,
      });
      recordWakeFailure(session, sessionDirectory, "spawn-no-pid");
      return false;
    }

    writePidFile(sessionDirectory, child.pid);
    activeChildren.set(session.id, {
      process: child,
      pid: child.pid,
      sessionDir: sessionDirectory,
      markStopped,
    });
    markRunning();
    clearWakeFailure(session.id, sessionDirectory);

    const stderrTail: string[] = [];
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (!line) continue;
        const scrubbed = scrubAgentLogLine(line);
        log.debug(scrubbed, { processAgent: session.agent_group_id });
        stderrTail.push(scrubbed);
        if (stderrTail.length > 10) stderrTail.shift();
      }
    });
    child.stdout?.on("data", () => {});

    child.on("close", (code) => {
      forgetChild(session.id, sessionDirectory, markStopped);
      if (code !== 0 && code !== null && stderrTail.length > 0) {
        log.warn("Process agent exited non-zero", {
          sessionId: session.id,
          code,
          stderrTail,
        });
      } else {
        log.info("Process agent exited", { sessionId: session.id, code });
      }
    });

    child.on("error", (err) => {
      forgetChild(session.id, sessionDirectory, markStopped);
      log.error("Process agent spawn error", { sessionId: session.id, err });
    });

    log.info("Spawned process agent", {
      sessionId: session.id,
      pid: child.pid,
      workingRoot: sessionDirectory,
    });
    return true;
  } catch (err) {
    recordWakeFailure(
      session,
      sessionDirectory,
      err instanceof Error ? err.message : "wake-threw",
    );
    return false;
  }
}

export function isProcessRunning(sessionId: string): boolean {
  const entry = activeChildren.get(sessionId);
  if (!entry) return false;
  if (entry.killing) return false;
  if (!isPidAlive(entry.pid)) {
    // markStopped is stored on the tracked entry (forgetChild falls back to it).
    forgetChild(sessionId, entry.sessionDir);
    return false;
  }
  return true;
}

/**
 * Reap recorded PIDs under session dirs after host restart.
 * `sessionsRoot` should be `data/v2-sessions` (or equivalent).
 */
export function cleanupProcessOrphans(sessionsRoot?: string): void {
  const root = sessionsRoot ?? findDefaultSessionsRoot();
  if (!root || !fs.existsSync(root)) return;

  for (const agentDir of listDirs(root)) {
    for (const sessionDirectory of listDirs(agentDir)) {
      const pid = readPidFile(sessionDirectory);
      if (pid == null) continue;
      if (pid === process.pid) {
        clearPidFile(sessionDirectory);
        continue;
      }
      if (isPidAlive(pid)) {
        log.warn("Reaping orphan process agent", {
          pid,
          sessionDir: sessionDirectory,
        });
        terminatePid(pid, "SIGTERM");
        setTimeout(() => {
          if (isPidAlive(pid)) terminatePid(pid, "SIGKILL");
        }, KILL_GRACE_MS).unref?.();
      }
      clearPidFile(sessionDirectory);
    }
  }
}

function findDefaultSessionsRoot(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "data/v2-sessions"),
    path.resolve(process.cwd(), "data/sessions"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function listDirs(parent: string): string[] {
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name));
}

/** Test helper — clear in-memory tracking. */
export function resetProcessDriverStateForTests(): void {
  activeChildren.clear();
  wakeFailures.clear();
}

export const processDriver: RuntimeDriver = {
  wake: wakeProcess,
  kill: killTracked,
  isRunning: isProcessRunning,
  cleanupOrphans: () => cleanupProcessOrphans(),
};
