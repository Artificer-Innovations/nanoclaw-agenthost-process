import { describe, expect, it, vi } from "vitest";

const register = vi.fn((..._args: unknown[]) => () => {});
vi.mock("./agenthosts.js", () => ({
  registerRuntimeDriver: (name: string, driver: unknown) =>
    register(name, driver),
}));

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./process-runtime.js", () => ({
  processDriver: { wake: vi.fn(), kill: vi.fn(), isRunning: vi.fn() },
}));

describe("process-boot", () => {
  it("registers process driver", async () => {
    const { startAgenthostProcess } = await import("./process-boot.js");
    startAgenthostProcess();
    expect(register).toHaveBeenCalledWith("process", expect.any(Object));
  });
});
