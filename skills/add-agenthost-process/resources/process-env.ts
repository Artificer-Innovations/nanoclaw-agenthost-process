/**
 * NanoClaw does not dotenv-load arbitrary keys into process.env.
 * Process boot applies host opt-in keys from `.env` when unset — same
 * pattern as sessionio's SESSIONIO_* apply (LaunchAgents often omit them).
 */

export const PROCESS_HOST_ENV_KEYS = [
  "NANOCLAW_ALLOW_PROCESS_RUNTIME",
] as const;

export type ProcessHostEnvKey = (typeof PROCESS_HOST_ENV_KEYS)[number];

export function applyProcessHostEnvFromFile(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (keys: string[]) => Record<string, string> = () => ({}),
): void {
  const fromFile = readFile([...PROCESS_HOST_ENV_KEYS]);
  for (const key of PROCESS_HOST_ENV_KEYS) {
    const value = fromFile[key]?.trim();
    if (value && !env[key]?.trim()) {
      env[key] = value;
    }
  }
}
