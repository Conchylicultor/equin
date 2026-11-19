import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import {
  readdir,
  readFile,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { join } from "node:path";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { SYSTEM_ACCOUNT_ID } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { recheckClaudeCodeNow } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { claudeCodeProblem } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { bundledClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/sdk/machine";
import { claudeSessionEnv } from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import type { ClaudeSignInFlow, ClaudeSignInMethod } from "../../core";
import { claudeSignInDir } from "../../data-dirs";
import {
  failureMessage,
  parseBrowserUrl,
  parseManualUrl,
  signInArgs,
} from "./cli-output";
import { currentSignInFlow, publishSignInFlow } from "./flow-state";

// The computer's one sign-in: Claude Code's own `auth login`, run as a child
// of this backend. Claude Code stores the login itself; the app never sees a
// credential.
//
// Nothing is polled. Claude Code hands the sign-in page to a $BROWSER shim
// that appends it to a file in the run's own folder; a watch of that folder
// re-reads it on every change. The child's exit decides the outcome.
//
// `auth login` writes plain text: its stdout/stderr are one file descriptor
// onto a file in the same folder, never a pipe (`infra/spawn`'s wedge), and
// only stdin is a pipe — a write-only sink, no stream pull — for the code the
// user pastes.

const OUTPUT = "output";
const HANDED = "browser-url";
const SHIM = "browser.sh";

/** A running Claude Code, as the run drives it. */
interface Child {
  exited: Promise<number>;
  kill(): void;
  /** Type a line, as the user would. */
  send(line: string): Promise<void>;
}

interface Run {
  id: string;
  method: ClaudeSignInMethod;
  dir: AppPath;
  child: Child | null;
  releaseWatch: (() => void | Promise<void>) | null;
}

let running: Run | null = null;

/** Publish a step of `run` — only while it is the one running. */
function publish(run: Run, next: ClaudeSignInFlow): void {
  if (running === run) publishSignInFlow(next);
}

/** A run's folder is named `<pid>-<id>`: the backend that owns it. */
function runDirName(id: string): string {
  return `${process.pid}-${id}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM: alive, owned by someone else.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}

/**
 * Remove the folders of runs whose backend is gone (killed mid-sign-in).
 * Every backend on the machine shares
 * the data dir, so a live backend's runs are left alone (this one's own ended
 * runs removed their folders already).
 */
async function sweepOrphanedRuns(root: AppPath): Promise<void> {
  for (const name of await readdir(root)) {
    const pid = Number(name.split("-", 1)[0]);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) continue;
    await rm(joinAppPath(root, name), { recursive: true, force: true });
  }
}

/** The shim Claude Code runs instead of a browser: it records the page, opens nothing. */
async function writeBrowserShim(dir: AppPath): Promise<string> {
  const quoted = `'${join(dir, HANDED).replaceAll("'", `'\\''`)}'`;
  const shim = joinAppPath(dir, SHIM);
  await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quoted}\n`);
  await chmod(shim, 0o700);
  return shim;
}

async function readIfThere(path: AppPath): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** What Claude Code has said so far. */
function readOutput(run: Run): Promise<string> {
  return readIfThere(joinAppPath(run.dir, OUTPUT));
}

/** Re-read what Claude Code has said so far, and publish it if it moved. */
async function readProgressNow(run: Run): Promise<void> {
  const flow = currentSignInFlow();
  if (running !== run || flow.kind !== "waiting" || flow.id !== run.id) return;
  const output = await readOutput(run);
  const url = parseBrowserUrl(await readIfThere(joinAppPath(run.dir, HANDED)));
  const manualUrl = parseManualUrl(output);
  // The files were read asynchronously: publish only if the run is still the
  // one waiting, on top of the flow as it stands now.
  const now = currentSignInFlow();
  if (running !== run || now.kind !== "waiting" || now.id !== run.id) return;
  if (url !== now.url || manualUrl !== now.manualUrl)
    publish(run, { ...now, url, manualUrl });
}

// Reads of one run's progress are serialized, so a slow read never publishes
// over a newer one.
const progressMutex = createKeyedMutex();

/** Re-read a run's progress (from a watch: nothing awaits it). */
function readProgress(run: Run): void {
  void runTracked("claude-sign-in.read-progress", () =>
    progressMutex.run(run.id, () => readProgressNow(run)),
  );
}

/** Plain text into the run's `output` file, the code on stdin. */
async function spawnPlain(
  args: string[],
  dir: AppPath,
  env: Record<string, string | undefined>,
): Promise<Child> {
  const out = await openOwnedFd(joinAppPath(dir, OUTPUT), "w", 0o600);
  try {
    const child = Bun.spawn([await bundledClaudeBin(), ...args], {
      cwd: dir,
      env,
      stdin: "pipe",
      stdout: out.fd,
      stderr: out.fd,
    });
    return {
      exited: child.exited,
      kill: () => child.kill(),
      send: async (line) => {
        await child.stdin.write(`${line}\n`);
        await child.stdin.flush();
      },
    };
  } finally {
    out.close();
  }
}

/** Stop a run: its child, its watch, its folder. Idempotent. */
async function endRun(run: Run): Promise<void> {
  if (running === run) running = null;
  run.child?.kill();
  const release = run.releaseWatch;
  run.releaseWatch = null;
  if (release) await release();
  await rm(run.dir, { recursive: true, force: true });
}

/**
 * Start a sign-in with `method`, cancelling the one running: there is one
 * sign-in at a time on this computer, and starting again is the user asking
 * again (another method, Try again, a second tab). Answers the run's id.
 */
export async function startSignIn(method: ClaudeSignInMethod): Promise<string> {
  if (running) await endRun(running);
  const id = crypto.randomUUID();
  // The real path of the app's own sign-in dir.
  const root = asAppPath(await realpath(await claudeSignInDir.ensure()));
  await sweepOrphanedRuns(root);
  const dir = joinAppPath(root, runDirName(id));
  await mkdir(dir, { mode: 0o700 });
  const run: Run = { id, method, dir, child: null, releaseWatch: null };
  running = run;
  publish(run, { kind: "waiting", id, method, url: null, manualUrl: null });

  run.releaseWatch = await acquireDirWatch({
    dir,
    scope: "subtree",
    onChange: () => readProgress(run),
  });

  // The spawn's inputs are resolved BEFORE the still-running check, so a
  // cancel or replace meanwhile is seen by it rather than leaving the spawn to
  // a run already ended.
  const env: Record<string, string | undefined> = {
    // The computer's own login: no added account's credential, nothing
    // inherited from this backend's environment.
    ...(await claudeSessionEnv(SYSTEM_ACCOUNT_ID)),
    BROWSER: await writeBrowserShim(dir),
  };

  if (running !== run) {
    // Cancelled or replaced while the watch opened or the inputs resolved.
    await endRun(run);
    return id;
  }

  run.child = await spawnPlain(signInArgs(method), dir, env);
  if (running !== run) {
    // Cancelled or replaced while the spawn resolved the executable: its
    // `endRun` found no child to stop, so this one is owned by nobody — end
    // the run again (idempotent), now with the child to kill and close.
    await endRun(run);
    return id;
  }
  const child = run.child;
  void runTracked("claude-sign-in.settle", () => settle(run, child));
  // Claude Code may have written before the watch went live.
  readProgress(run);
  return id;
}

/** The run's outcome, once its Claude Code exits. */
async function settle(run: Run, child: Child): Promise<void> {
  const exitCode = await child.exited;
  if (running !== run) return; // cancelled or replaced: already ended
  const output = await readOutput(run);
  const { id, method } = run;
  try {
    if (exitCode !== 0) {
      publish(run, {
        kind: "failed",
        id,
        method,
        error: failureMessage(output, exitCode),
      });
      return;
    }
    // The health row flips through the probe's own push, and armed
    // auto-start tasks resume on its `onClaudeCodeReady`.
    const status = await recheckClaudeCodeNow();
    publish(
      run,
      status.kind === "ready"
        ? { kind: "done", id, method }
        : {
            kind: "failed",
            id,
            method,
            error: `Claude Code finished signing in, but: ${claudeCodeProblem(status)}.`,
          },
    );
  } catch (err) {
    publish(run, {
      kind: "failed",
      id,
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await endRun(run);
  }
}

/** Hand Claude Code the code the sign-in page showed on another device. */
export async function submitSignInCode(
  id: string,
  code: string,
): Promise<void> {
  const run = running;
  if (!run?.child || run.id !== id)
    throw new HttpError(409, "That sign-in is no longer running.");
  await run.child.send(code);
}

/** Stop the run `id`, or dismiss its outcome: the flow reads idle. */
export async function cancelSignIn(id: string): Promise<void> {
  if (running?.id === id) await endRun(running);
  const flow = currentSignInFlow();
  if (flow.kind !== "idle" && flow.id === id)
    publishSignInFlow({ kind: "idle" });
}
