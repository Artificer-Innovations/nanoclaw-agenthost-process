import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const register = vi.fn((..._args: unknown[]) => () => {});
const isAllowed = vi.fn(() => false);

vi.mock("./agenthosts.js", () => ({
  registerRuntimeDriver: (name: string, driver: unknown) =>
    register(name, driver),
}));

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./process-runtime.js", () => ({
  processDriver: { wake: vi.fn(), kill: vi.fn(), isRunning: vi.fn() },
  isProcessRuntimeAllowed: () => isAllowed(),
}));

describe("process-boot", () => {
  beforeEach(() => {
    register.mockClear();
    isAllowed.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("registers process driver and warns when allow-env unset", async () => {
    isAllowed.mockReturnValue(false);
    const { log } = await import("./log.js");
    const { startAgenthostProcess } = await import("./process-boot.js");
    startAgenthostProcess();
    expect(register).toHaveBeenCalledWith("process", expect.any(Object));
    expect(log.warn).toHaveBeenCalled();
  });

  it("registers process driver and info-logs when allow-env set", async () => {
    isAllowed.mockReturnValue(true);
    const { log } = await import("./log.js");
    const { startAgenthostProcess } = await import("./process-boot.js");
    startAgenthostProcess();
    expect(register).toHaveBeenCalledWith("process", expect.any(Object));
    expect(log.info).toHaveBeenCalled();
  });
});
