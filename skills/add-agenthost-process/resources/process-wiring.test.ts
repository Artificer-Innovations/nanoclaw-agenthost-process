import { describe, expect, it, vi } from "vitest";

vi.mock("./agenthosts.js", () => ({
  registerRuntimeDriver: vi.fn(() => () => {}),
}));

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./process-runtime.js", () => ({
  processDriver: { wake: vi.fn(), kill: vi.fn(), isRunning: vi.fn() },
  isProcessRuntimeAllowed: () => true,
}));

describe("process wiring", () => {
  it("exports startAgenthostProcess from boot module shape", async () => {
    const mod = await import("./process-boot.js");
    expect(typeof mod.startAgenthostProcess).toBe("function");
    mod.startAgenthostProcess();
  });
});
