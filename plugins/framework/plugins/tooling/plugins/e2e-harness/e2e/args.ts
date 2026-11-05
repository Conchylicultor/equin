/**
 * Argv parsing for e2e scripts.
 *
 * Replaces the byte-identical `arg(name, fallback)` copy that lived in 22 of the
 * 29 scripts, plus the three divergent missing-argument endings (`exit(1)`,
 * `exit(2)`, and one that silently defaulted).
 *
 * # Both spellings, because a flag we cannot see is a flag we drop
 *
 * `--name value` and `--name=value` are the same flag. Reading only the first
 * is not a missing convenience: `indexOf("--composition")` answers "absent" to
 * `--composition=sonata`, so the run does not refuse, does not warn, and does
 * not target what it was told to — it targets this checkout's own app and
 * prints ALL CHECKS PASSED. For a *deploy selector* that is precisely the
 * silently-drove-somebody-else's-app class the target machinery exists to end,
 * reintroduced one layer below it. So the two spellings are resolved here, once,
 * for every flag rather than for the ones somebody remembered.
 *
 * `--name=` (an empty value) is a value, not an absence — it comes back as `""`,
 * which is what lets a caller be told they named a flag and gave it nothing
 * instead of silently getting the default.
 */

/**
 * The value the caller gave `--name`, in either spelling, or `undefined`.
 *
 * A trailing `--name` with nothing after it yields `undefined` (there is no
 * value), while `--name=` yields `""` (there is one, and it is empty).
 */
export function harnessArg(name: string): string | undefined {
  const bare = `--${name}`;
  const inline = `${bare}=`;
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === bare) return argv[i + 1];
    if (token.startsWith(inline)) return token.slice(inline.length);
  }
  return undefined;
}

/**
 * Flags a SCRIPT asked for (`arg` / `numArg` / `flag`), as opposed to the ones
 * the harness reads itself (`harnessArg`). A flag the harness shares with the
 * script (`--path`) is honoured once the script reads it, so the teardown check
 * for an ignored `--path` (`target.ts`'s `unconsumedPage`) can tell "the script
 * drives its own page" from "the script took `--path` itself".
 */
const readByScript = new Set<string>();

export function wasReadByScript(name: string): boolean {
  return readByScript.has(name);
}

export function arg(name: string): string | undefined;
export function arg(name: string, fallback: string): string;
export function arg(name: string, fallback?: string): string | undefined {
  readByScript.add(name);
  return harnessArg(name) ?? fallback;
}

/** Numeric flag. A non-numeric value is a caller error, not a silent 0. */
export function numArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) usage(`--${name} expects a number, got ${raw}`);
  return n;
}

/**
 * Presence-only flag (`--headed`, `--verbose`).
 *
 * True for `--name=anything` too, so that a value-taking flag spelled inline is
 * still PRESENT to the callers that ask presence and value separately to tell
 * "named it and gave nothing" from "did not name it".
 */
export function flag(name: string): boolean {
  readByScript.add(name);
  const bare = `--${name}`;
  const inline = `${bare}=`;
  return process.argv.some((t) => t === bare || t.startsWith(inline));
}

/** Print a usage line and exit non-zero. Never returns. */
export function usage(line: string): never {
  console.error(line);
  process.exit(2);
}

/** A flag with no sensible default — absent means the caller misinvoked us. */
export function requireArg(name: string, usageLine: string): string {
  const value = arg(name);
  if (value === undefined || value === "") usage(usageLine);
  return value;
}
