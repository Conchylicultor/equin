import { tmpdir } from "node:os";
import {
  downloadedFile,
  type DownloadSource,
} from "@plugins/infra/plugins/deps/plugins/download/deps";
import { ensureDep, type Ready } from "@plugins/infra/plugins/deps/deps";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { waitForFlock } from "@plugins/packages/plugins/flock/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { codesignDir } from "../../data-dirs";
import { rcodesign } from "./rcodesign";

/**
 * Where `rcodesign` (the local identity's signer) comes from:
 *
 * - `exec` — installed on demand. Only an out-of-process context holds an
 *   `ExecContext` (a CLI command, a supervised job, a build's `then`).
 * - `installed` — already installed: a serving backend, which may not install
 *   anything on its event loop, waits for the dependency through `deps`
 *   (`requestDep` + `readyNow`) and hands over the `Ready`.
 */
export type RcodesignTool =
  | { readonly exec: ExecContext }
  | { readonly installed: Ready<DownloadSource> };

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Everything this plugin reads from the machine, as one value: the OS, the
 * environment, where its state lives, how it runs a command, takes its lock
 * and finds `rcodesign`. Production code uses {@link machineHost}; tests pass
 * their own, so `security` / `codesign` are never really called by a test.
 */
export interface CodesignHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The codesign data dir (`~/.equin/state/codesign`). */
  readonly dir: string;
  /** Run one command to completion. A non-zero exit is a result, not a throw. */
  run(argv: readonly string[]): Promise<CommandResult>;
  /** Run `fn` holding the machine-wide lock on `path`. */
  withLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
  /** The `rcodesign` executable, from `tool`. */
  rcodesignPath(tool: RcodesignTool): Promise<string>;
}

/** No signing tool call takes longer than this (a cold `security` can be slow). */
const COMMAND_TIMEOUT_MS = 2 * 60_000;

/** The real machine. */
export function machineHost(): CodesignHost {
  return {
    platform: process.platform,
    env: process.env,
    dir: codesignDir.path,
    async run(argv) {
      const result = await spawnCaptured([...argv], {
        cwd: tmpdir(),
        env: { ...process.env },
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (result.timedOut) {
        throw new Error(
          `\`${argv.join(" ")}\` did not finish within ${COMMAND_TIMEOUT_MS / 1000}s — is it waiting on a keychain dialog?`,
        );
      }
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    async withLock(path, fn) {
      const held = await waitForFlock(path);
      try {
        return await fn();
      } finally {
        await held.release();
      }
    },
    async rcodesignPath(tool) {
      const ready =
        "installed" in tool
          ? tool.installed
          : await ensureDep(rcodesign, tool.exec);
      return downloadedFile(ready, "rcodesign");
    },
  };
}

/** `run`, throwing on a non-zero exit with the command and its stderr. */
export async function runOk(
  host: CodesignHost,
  argv: readonly string[],
): Promise<CommandResult> {
  const result = await host.run(argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
    );
  }
  return result;
}
