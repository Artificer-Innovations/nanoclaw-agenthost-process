import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const register = vi.fn((..._args: unknown[]) => () => {});
const readEnvFile = vi.fn((_keys: string[]): Record<string, string> => ({}));

vi.mock("./agenthosts.js", () => ({
  registerRuntimeDriver: (name: string, driver: unknown) =>
    register(name, driver),
}));

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./env.js", () => ({
  readEnvFile: (keys: string[]) => readEnvFile(keys),
}));

vi.mock("./process-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./process-runtime.js")>(
    "./process-runtime.js",
  );
  return {
    ...actual,
    processDriver: { wake: vi.fn(), kill: vi.fn(), isRunning: vi.fn() },
  };
});

describe("process-boot", () => {
  const prevAllow = process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME;

  beforeEach(() => {
    register.mockClear();
    readEnvFile.mockReset();
    readEnvFile.mockReturnValue({});
    delete process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME;
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevAllow === undefined)
      delete process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME;
    else process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME = prevAllow;
  });

  it("registers process driver and warns when allow-env unset", async () => {
    const { log } = await import("./log.js");
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    const { startAgenthostProcess } = await import("./process-boot.js");
    startAgenthostProcess();
    expect(register).toHaveBeenCalledWith("process", expect.any(Object));
    expect(log.warn).toHaveBeenCalled();
    expect(readEnvFile).toHaveBeenCalledWith([
      "NANOCLAW_ALLOW_PROCESS_RUNTIME",
    ]);
  });

  it("registers process driver and info-logs when allow-env set in process.env", async () => {
    process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME = "1";
    const { log } = await import("./log.js");
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    const { startAgenthostProcess } = await import("./process-boot.js");
    startAgenthostProcess();
    expect(register).toHaveBeenCalledWith("process", expect.any(Object));
    expect(log.info).toHaveBeenCalled();
  });

  it("applies allow from .env when process.env unset", async () => {
    readEnvFile.mockReturnValue({ NANOCLAW_ALLOW_PROCESS_RUNTIME: "true" });
    const { log } = await import("./log.js");
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    const { startAgenthostProcess } = await import("./process-boot.js");
    startAgenthostProcess();
    expect(process.env.NANOCLAW_ALLOW_PROCESS_RUNTIME).toBe("true");
    expect(log.info).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
