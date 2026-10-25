// Reading and writing the app's own environment variables, by key.
//
// Each key has two names during the rename window (`envNames` in
// `env-keys.ts`). Code on both sides of every boundary — the installed plist,
// the gateway, a backend, the CLI, an agent's hooks — can be on different
// versions, so:
//
//  - a READ tries `EQUIN_<key>`, then the legacy name;
//  - a WRITE sets both, so a reader on either version sees it;
//  - an UNSET removes both.
//
// Both names set to DIFFERENT values cannot come from current code, which
// always writes both. It means an older writer overrode one name under a
// newer ancestor, or an operator exported both — and which value is meant is
// not knowable here, so the read throws rather than guess.

import { envName, envNames, type EnvKey } from "./env-keys";

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

/** Both names of one key are set, to different values. */
export class EnvNameConflictError extends Error {
  constructor(
    readonly key: EnvKey,
    readonly values: Readonly<Record<string, string>>,
  ) {
    const shown = Object.entries(values)
      .map(([n, v]) => `${n}=${JSON.stringify(v)}`)
      .join(" and ");
    super(
      `${shown} disagree. Both names of one variable are set to different values — unset one (${envName(key)} is the current name).`,
    );
    this.name = "EnvNameConflictError";
  }
}

/**
 * The value of `key` in `env` (the process environment by default), under
 * either of its names, or undefined when neither is set. Throws
 * `EnvNameConflictError` when both are set and differ.
 */
export function readEnv(
  key: EnvKey,
  env: Readonly<Env> = ambientEnv(),
): string | undefined {
  const [current, legacy] = envNames(key);
  const value = env[current];
  if (legacy === undefined) return value;
  const old = env[legacy];
  if (value === undefined) return old;
  if (old !== undefined && old !== value) {
    throw new EnvNameConflictError(key, { [current]: value, [legacy]: old });
  }
  return value;
}

/**
 * Environment entries for `values`, every key under all its names — what a
 * spawn spreads into a child's env: `{ ...process.env, ...envEntries({ LANE: "background" }) }`.
 * An undefined value stays undefined under every name, so spreading it still
 * means "not set for the child".
 */
export function envEntries<V extends string | undefined>(
  values: Partial<Record<EnvKey, V>>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(values) as [EnvKey, V][]) {
    for (const name of envNames(key)) out[name] = value;
  }
  return out;
}

/** Sets `key` under all its names in `env` (the process environment by default). */
export function setEnv(
  key: EnvKey,
  value: string,
  env: Env = writableEnv(),
): void {
  for (const name of envNames(key)) env[name] = value;
}

/**
 * The `??=` form: sets `key` to `value` unless it is already set under either
 * name, and returns what `key` now reads as. An existing value is copied to
 * every name, so a descendant on either version reads the same.
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

/** Removes `key` under all its names from `env` (the process environment by default). */
export function unsetEnv(key: EnvKey, env: Env = writableEnv()): void {
  for (const name of envNames(key)) delete env[name];
}
