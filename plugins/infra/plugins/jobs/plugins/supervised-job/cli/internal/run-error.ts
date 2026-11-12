// A supervised child's own account of why it failed.
//
// The built-in ledger closes a failed run WITH its error. A `run` body's child
// records it on the run's row itself (`recordRunError`); an `argv` child — an
// `./equin` command (`type-check-backstop`, `check --scope host`, a build) —
// has no row to write and no database, so its error used to be recovered from
// the end of its transcript. For a crash that end is the STACK, not the
// message: 2 KB of `at …` frames after the line that said what happened. The
// type-check backstop's deaths were dead-lettered as "recorded no error" with
// its transcript's frames while its message — a file "changed on disk after the
// check took its tree" — sat 3 KB further up.
//
// So the shim names a file (`RUN_ERROR_ENV`, `worktreeArtifacts.runError`), the
// dying command writes its uncaught exception there (`runCli`, through
// op-runtime's `recordCliCrash` and this plugin's `cli/` writer), and the ledger
// reads it (`readRunError`, `server/internal/run/tail.ts`) before falling back to
// the transcript.

// This is the writer, in `cli/` because it runs only in a CLI process, on its
// way out: a synchronous write is right there, and wrong on any backend thread.

import { renameSync, writeFileSync } from "node:fs";
import { RUN_ERROR_ENV } from "../../core/internal/shim";

/**
 * How much of a recorded error is kept: its HEAD — the message and the first
 * frames — which is where an error says what happened. A chained error
 * (`type-check worker exited 1:` quoting its batch's stderr, quoting the batch's
 * own error) carries its root cause well inside this.
 */
export const RUN_ERROR_MAX_CHARS = 4096;

/**
 * Take this process's run-error path out of its environment: the path when it
 * is a supervised run's child, else `null`. Removed from `process.env` so a
 * command this one spawns (a build's `check`) does not inherit it and write the
 * parent's record. Call once, as the process starts.
 */
export function takeRunErrorPath(): string | null {
  const path = process.env[RUN_ERROR_ENV];
  delete process.env[RUN_ERROR_ENV];
  return path === undefined || path === "" ? null : path;
}

/** The error text a thrown value records: its stack (message first), head-capped. */
export function runErrorText(err: unknown): string {
  const text =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  return text.length <= RUN_ERROR_MAX_CHARS
    ? text
    : `${text.slice(0, RUN_ERROR_MAX_CHARS)}\n… ${text.length - RUN_ERROR_MAX_CHARS} more character(s)`;
}

/**
 * Record `err` at `path`, atomically (tmp + rename, so the ledger never reads a
 * half-written record). Synchronous: it runs on the way out of a dying process.
 */
export function writeRunErrorSync(path: string, err: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, runErrorText(err));
  renameSync(tmp, path);
}
