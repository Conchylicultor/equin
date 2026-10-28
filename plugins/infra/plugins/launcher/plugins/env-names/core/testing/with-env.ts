import { envName, type EnvKey } from "../internal/env-keys";

/**
 * Runs `fn` with `values` set in `process.env` (undefined = unset), then puts
 * back exactly what was there before — the save / set / restore a test of an
 * env reader needs.
 */
export async function withEnv<T>(
  values: Partial<Record<EnvKey, string | undefined>>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values) as [
    EnvKey,
    string | undefined,
  ][]) {
    const name = envName(key);
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
