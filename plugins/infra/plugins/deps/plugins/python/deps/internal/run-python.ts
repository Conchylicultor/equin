import type { z } from "zod";
import { join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { Ready } from "@plugins/infra/plugins/deps/deps";
import type { PythonEnvSource } from "./python-env";

/** A Python entry point exited non-zero, or did not print one JSON document. */
export class PythonEntryError extends Error {
  constructor(
    readonly module: string,
    readonly exitCode: number,
    readonly stderrTail: string,
    detail: string,
  ) {
    super(
      `python -m ${module}: ${detail}` +
        (stderrTail === "" ? "" : `\n--- stderr (tail) ---\n${stderrTail}`),
    );
  }
}

/** What bounds one run: a deadline, or the caller's cancellation. */
type RunBound = { timeoutMs: number } | { signal: AbortSignal };

export type RunPythonOptions<T> = RunBound & {
  /** The module to run with `python -m`, from the project's own source. */
  module: string;
  /** Sent as ONE JSON document on stdin. */
  input: unknown;
  /** Parses the ONE JSON document the module prints on stdout — never a cast. */
  output: z.ZodType<T>;
  /** Where the module's stderr goes, line by line (its progress and warnings). */
  log?: (line: string) => void;
};

function tail(text: string, lines = 30): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Run one module of a Python dependency's project: JSON on stdin, exactly one
 * JSON document on stdout, stderr to `log`.
 *
 * Takes the `Ready` proof, so "forgot to ensure" is a type error. The env is
 * the installed one; the source is this checkout's (`PYTHONPATH` = the
 * project), so a worktree runs its own code against a shared env.
 */
export async function runPython<T>(
  ready: Ready<PythonEnvSource>,
  opts: RunPythonOptions<T>,
): Promise<T> {
  const projectDir = join(REPO_ROOT, ready.dep.source.project);
  const bound =
    "timeoutMs" in opts
      ? { timeoutMs: opts.timeoutMs }
      : { signal: opts.signal };
  const result = await spawnCaptured(
    [join(ready.dir, "bin", "python"), "-m", opts.module],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        PYTHONPATH: projectDir,
        PYTHONUNBUFFERED: "1",
        // The project dir is a checkout: no bytecode left in it.
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdin: JSON.stringify(opts.input),
      ...bound,
    },
  );
  const stderr = result.stderr;
  if (opts.log !== undefined) {
    for (const line of stderr.split("\n")) if (line !== "") opts.log(line);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new PythonEntryError(
      opts.module,
      result.exitCode,
      tail(stderr),
      result.timedOut
        ? "timed out and was killed"
        : `exited ${result.exitCode}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new PythonEntryError(
      opts.module,
      result.exitCode,
      tail(stderr),
      `stdout is not one JSON document (${err instanceof Error ? err.message : String(err)}): ${tail(result.stdout, 5)}`,
    );
  }
  return opts.output.parse(parsed);
}
