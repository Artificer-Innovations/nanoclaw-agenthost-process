import { describe, expect, it } from "vitest";
import {
  PROCESS_HOST_ENV_KEYS,
  applyProcessHostEnvFromFile,
} from "./process-env.js";

describe("applyProcessHostEnvFromFile", () => {
  it("copies allow key from file when process.env unset", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProcessHostEnvFromFile(env, () => ({
      NANOCLAW_ALLOW_PROCESS_RUNTIME: "1",
    }));
    expect(env.NANOCLAW_ALLOW_PROCESS_RUNTIME).toBe("1");
  });

  it("does not override an existing process.env value", () => {
    const env: NodeJS.ProcessEnv = { NANOCLAW_ALLOW_PROCESS_RUNTIME: "0" };
    applyProcessHostEnvFromFile(env, () => ({
      NANOCLAW_ALLOW_PROCESS_RUNTIME: "1",
    }));
    expect(env.NANOCLAW_ALLOW_PROCESS_RUNTIME).toBe("0");
  });

  it("ignores blank file values", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProcessHostEnvFromFile(env, () => ({
      NANOCLAW_ALLOW_PROCESS_RUNTIME: "  ",
    }));
    expect(env.NANOCLAW_ALLOW_PROCESS_RUNTIME).toBeUndefined();
  });

  it("defaults to a no-op reader", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProcessHostEnvFromFile(env);
    expect(env.NANOCLAW_ALLOW_PROCESS_RUNTIME).toBeUndefined();
  });

  it("exports the allow key", () => {
    expect(PROCESS_HOST_ENV_KEYS).toContain("NANOCLAW_ALLOW_PROCESS_RUNTIME");
  });
});
