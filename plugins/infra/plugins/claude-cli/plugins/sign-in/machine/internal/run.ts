import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { SYSTEM_ACCOUNT_ID } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { addClaudeAccountWithCredential } from "@plugins/infra/plugins/claude-cli/plugins/accounts/machine";
import { recheckClaudeCodeNow } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { claudeCodeProblem } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { bundledClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/sdk/machine";
import { claudeSessionEnv } from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import type { ClaudeSignInFlow, ClaudeSignInTarget } from "../../core";
import { claudeSignInDir } from "../../data-dirs";
import {
  failureMessage,
  parseBrowserUrl,
  parseManualUrl,
  parseSetupToken,
  readSetupTokenScreen,
  signInArgs,
} from "./cli-output";
import { createScreen, type Screen } from "./screen";
import { currentSignInFlow, publishSignInFlow } from "./flow-state";

// The computer's one sign-in: Claude Code's own `auth login` (the computer) or
// `setup-token` (a new account), run as a child of this backend.
//
// Nothing is polled. Claude Code hands the sign-in page to a $BROWSER shim
// that appends it to a file in the run's own folder; a watch of that folder
// re-reads it on every change. The child's exit decides the outcome.
//
// - `auth login` writes plain text: its stdout/stderr are one file descriptor
//   onto a file in the same folder, never a pipe (`infra/spawn`'s wedge), and
//   only stdin is a pipe — a write-only sink, no stream pull — for the code
//   the user pastes.
// - `setup-token` is a terminal UI with no plain-text mode — without a
//   terminal it shows nothing until it exits, and on an error it waits for
//   Enter forever — so it runs under a pseudo-terminal whose output Bun pushes
//   to a callback, drawn onto a terminal emulator (`screen.ts`) and read back
//   as the text a person would see. Its retry prompt fails the run.

const OUTPUT = "output";
const HANDED = "browser-url";
const SHIM = "browser.sh";

/** Wide enough that no URL or token Claude Code draws is wrapped. */
const SCREEN_SIZE = { cols: 1000, rows: 50 } as const;

/** A running Claude Code, as the run drives it. */
interface Child {
  exited: Promise<number>;
  /** Resolves once everything it wrote has been read. */
  outputDone: Promise<void>;
  kill(): void;
  /** Let go of what reads it — once the run has ended. */
  close(): void;
  /** Type a line, as the user would. */
  send(line: string): Promise<void>;
}

interface Run {
  id: string;
  target: ClaudeSignInTarget;
  dir: string;
  child: Child | null;
  /** `setup-token`'s screen; `auth login` writes to the `output` file. */
  screen: Screen | null;
  /** The error `setup-token` stopped on, waiting for an Enter never sent. */
  stuck: string | null;
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
 * Remove the folders of runs whose backend is gone (killed mid-sign-in): one
 * may hold a token Claude Code printed. Every backend on the machine shares
 * the data dir, so a live backend's runs are left alone (this one's own ended
 * runs removed their folders already).
 */
function sweepOrphanedRuns(root: string): void {
  for (const name of readdirSync(root)) {
    const pid = Number(name.split("-", 1)[0]);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) continue;
    rmSync(join(root, name), { recursive: true, force: true });
  }
}

/** The shim Claude Code runs instead of a browser: it records the page, opens nothing. */
function writeBrowserShim(dir: string): string {
  const quoted = `'${join(dir, HANDED).replaceAll("'", `'\\''`)}'`;
  const shim = join(dir, SHIM);
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quoted}\n`);
  chmodSync(shim, 0o700);
  return shim;
}

function readIfThere(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** What Claude Code has said so far. */
function readOutput(run: Run): string {
  return run.screen ? run.screen.text() : readIfThere(join(run.dir, OUTPUT));
}

/**
 * Re-read what Claude Code has said so far, and publish it if it moved. A
 * `setup-token` on its retry prompt is stopped: its exit fails the run.
 */
function readProgress(run: Run): void {
  const flow = currentSignInFlow();
  if (running !== run || flow.kind !== "waiting" || flow.id !== run.id) return;
  const output = readOutput(run);
  if (run.screen && run.stuck === null) {
    const screen = readSetupTokenScreen(output);
    if (screen.kind === "stuck") {
      run.stuck = screen.error;
      run.child?.kill();
      return;
    }
  }
  const url = parseBrowserUrl(readIfThere(join(run.dir, HANDED)));
  const manualUrl = parseManualUrl(output);
  if (url !== flow.url || manualUrl !== flow.manualUrl)
    publish(run, { ...flow, url, manualUrl });
}

/** `auth login`: plain text into the run's `output` file, the code on stdin. */
function spawnPlain(
  args: string[],
  dir: string,
  env: Record<string, string | undefined>,
): Child {
  const out = openSync(join(dir, OUTPUT), "w", 0o600);
  try {
    const child = Bun.spawn([bundledClaudeBin(), ...args], {
      cwd: dir,
      env,
      stdin: "pipe",
      stdout: out,
      stderr: out,
    });
    return {
      exited: child.exited,
      outputDone: Promise.resolve(),
      kill: () => child.kill(),
      close: () => {},
      send: async (line) => {
        await child.stdin.write(`${line}\n`);
        await child.stdin.flush();
      },
    };
  } finally {
    closeSync(out);
  }
}

/**
 * `setup-token`: under a pseudo-terminal drawn onto `screen`, every write
 * re-reading the run's progress. Its terminal queries (device attributes, the
 * keyboard protocol) go unanswered, so it keeps to plain keys and a typed
 * line is the line and Enter.
 */
function spawnOnScreen(
  args: string[],
  dir: string,
  env: Record<string, string | undefined>,
  screen: Screen,
  onDrawn: () => void,
): Child {
  const closed = Promise.withResolvers<void>();
  const child = Bun.spawn([bundledClaudeBin(), ...args], {
    cwd: dir,
    env,
    terminal: {
      ...SCREEN_SIZE,
      data: (_terminal, bytes) => void screen.write(bytes).then(onDrawn),
      exit: () => closed.resolve(),
    },
  });
  const terminal = child.terminal;
  if (!terminal) throw new Error("Bun.spawn gave setup-token no terminal");
  return {
    exited: child.exited,
    outputDone: closed.promise.then(() => screen.drawn()),
    kill: () => child.kill(),
    close: () => {
      terminal.close();
      screen.dispose();
    },
    send: (line) => {
      terminal.write(`${line}\r`);
      return Promise.resolve();
    },
  };
}

/** Stop a run: its child, its watch, its folder. Idempotent. */
async function endRun(run: Run): Promise<void> {
  if (running === run) running = null;
  run.child?.kill();
  run.child?.close();
  const release = run.releaseWatch;
  run.releaseWatch = null;
  if (release) await release();
  rmSync(run.dir, { recursive: true, force: true });
}

/**
 * Start a sign-in of `target`, cancelling the one running: there is one
 * sign-in at a time on this computer, and starting again is the user asking
 * again (another method, Try again, a second tab). Answers the run's id.
 */
export async function startSignIn(target: ClaudeSignInTarget): Promise<string> {
  if (running) await endRun(running);
  const id = crypto.randomUUID();
  const root = realpathSync(claudeSignInDir.ensure());
  sweepOrphanedRuns(root);
  const dir = join(root, runDirName(id));
  mkdirSync(dir, { mode: 0o700 });
  const run: Run = {
    id,
    target,
    dir,
    child: null,
    screen: null,
    stuck: null,
    releaseWatch: null,
  };
  running = run;
  publish(run, { kind: "waiting", id, target, url: null, manualUrl: null });

  run.releaseWatch = await acquireDirWatch({
    dir,
    scope: "subtree",
    onChange: () => readProgress(run),
  });
  if (running !== run) {
    // Cancelled while the watch opened.
    await endRun(run);
    return id;
  }

  const env: Record<string, string | undefined> = {
    // The computer's own login: no added account's credential, nothing
    // inherited from this backend's environment.
    ...(await claudeSessionEnv(SYSTEM_ACCOUNT_ID)),
    BROWSER: writeBrowserShim(dir),
  };
  // A new account's token is only printed, never stored: its own config dir
  // keeps the computer's login out of reach.
  if (target.kind === "new-account")
    env.CLAUDE_CONFIG_DIR = join(dir, "config");

  const args = signInArgs(target);
  if (target.kind === "new-account") {
    const screen = createScreen(SCREEN_SIZE);
    run.screen = screen;
    run.child = spawnOnScreen(args, dir, env, screen, () => readProgress(run));
  } else {
    run.child = spawnPlain(args, dir, env);
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
  await child.outputDone;
  if (running !== run) return;
  const output = readOutput(run);
  const { id, target } = run;
  try {
    if (run.stuck !== null || exitCode !== 0) {
      publish(run, {
        kind: "failed",
        id,
        target,
        error: run.stuck ?? failureMessage(output, exitCode),
      });
      return;
    }
    if (target.kind === "computer") {
      // The health row flips through the probe's own push, and armed
      // auto-start tasks resume on its `onClaudeCodeReady`.
      const status = await recheckClaudeCodeNow();
      publish(
        run,
        status.kind === "ready"
          ? { kind: "done", id, target }
          : {
              kind: "failed",
              id,
              target,
              error: `Claude Code finished signing in, but: ${claudeCodeProblem(status)}.`,
            },
      );
      return;
    }
    const printed = parseSetupToken(output);
    if (printed.kind === "no-token") {
      // Never observed yet (see cli-output.ts): say so loudly, and never put
      // the output itself in the report — it may hold a token we failed to read.
      reportServerError({
        message: `claude setup-token exited 0 without printing a token the app recognises (${output.length} characters of output)`,
      });
      publish(run, {
        kind: "failed",
        id,
        target,
        error: "setup-token finished without printing a token.",
      });
      return;
    }
    const account = await addClaudeAccountWithCredential(
      target.name,
      printed.token,
    );
    publish(run, { kind: "done", id, target, accountId: account.id });
  } catch (err) {
    publish(run, {
      kind: "failed",
      id,
      target,
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
