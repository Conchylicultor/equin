// Reading and writing the app's own environment variables, by key: each key's
// one name is `envName(key)` (`env-keys.ts`), so code never spells a full name.

import { envName, type EnvKey } from "./env-keys";

type Env = Record<string, string | undefined>;

/** The process environment when there is one (a browser has none). */
function ambientEnv(): Env {
  return globalThis.process?.env ?? {};
}

/** The process environment, for a write — there must be one. */
function writableEnv(): Env {
  const env = globalThis.process?.env;
  if (env === undefined) {
    throw new Error("no process environment to write to");
  }
  return env;
}

/**
 * The value of `key` in `env` (the process environment by default), or
 * undefined when it is not set.
 */
export function readEnv(
  key: EnvKey,
  env: Readonly<Env> = ambientEnv(),
): string | undefined {
  return env[envName(key)];
}

/**
 * Environment entries for `values`, each key under its name — what a spawn
 * spreads into a child's env: `{ ...process.env, ...envEntries({ LANE: "background" }) }`.
 * An undefined value stays undefined, so spreading it still means "not set for
 * the child".
 */
export function envEntries<V extends string | undefined>(
  values: Partial<Record<EnvKey, V>>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(values) as [EnvKey, V][]) {
    out[envName(key)] = value;
  }
  return out;
}

/** Sets `key` in `env` (the process environment by default). */
export function setEnv(
  key: EnvKey,
  value: string,
  env: Env = writableEnv(),
): void {
  env[envName(key)] = value;
}

/**
 * The `??=` form: sets `key` to `value` unless it is already set, and returns
 * what `key` now reads as.
 */
export function setEnvDefault(
  key: EnvKey,
  value: string,
  env: Env = writableEnv(),
): string {
  const resolved = readEnv(key, env) ?? value;
  setEnv(key, resolved, env);
  return resolved;
}

/** Removes `key` from `env` (the process environment by default). */
export function unsetEnv(key: EnvKey, env: Env = writableEnv()): void {
  delete env[envName(key)];
}
