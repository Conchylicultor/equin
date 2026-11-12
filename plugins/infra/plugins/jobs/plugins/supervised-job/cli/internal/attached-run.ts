import { fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { adoptFd } from "@plugins/packages/plugins/owned-fd/core";
import { constants } from "node:os";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { pruneWorktreeRunArtifactsSync } from "@plugins/infra/plugins/paths/server";
import { spawnToFile } from "@plugins/infra/plugins/spawn/core";
import { watchForCommand } from "@plugins/infra/plugins/file-watcher/cli";
import type { AttachedRun } from "./attached";
import { RUN_ERROR_ENV, RUN_TERMINAL_ENV } from "../../core/internal/shim";
import { assertRunId, assertRunKindId } from "../../core/internal/ids";
import { writeRunTerminalSync } from "../../core/internal/terminal";

/** The catchable signals an attached run's parent relays to its child. */
const RELAYED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

/** Bytes read per `readSync` while echoing the transcript. */
const ECHO_CHUNK_BYTES = 256 * 1024;

/** {@link AttachedRun}'s implementation — see `./attached`. */
export async function runAttachedNow(opts: AttachedRun): Promise<number> {
  assertRunKindId(opts.kindId);
  assertRunId(opts.kindId, opts.runId);
  const runsDir = worktreeArtifacts.runsDir(opts.namespace);
  const transcript = worktreeArtifacts.runTranscript(
    opts.namespace,
    opts.kindId,
    opts.runId,
  );
  const terminal = worktreeArtifacts.runTerminal(
    opts.namespace,
    opts.kindId,
    opts.runId,
  );
  // Same refusal as the backend's spawn: a marker already there would read the
  // new run as finished.
  if (existsSync(terminal)) {
    throw new Error(
      `[supervised-run] ${opts.kindId}: run id ${JSON.stringify(opts.runId)} already ` +
        `has an exit marker at ${terminal} — run ids must be unique.`,
    );
  }
  mkdirSync(runsDir, { recursive: true });
  // Created before the child exists, so the echo has a file from the start.
  adoptFd(openSync(transcript, "a")).close();
  // The same "a new set trims the old ones" rule the backend's spawn follows.
  pruneWorktreeRunArtifactsSync(opts.namespace, opts.kindId);

  const echo = createEcho(transcript);
  const watcher = await watchForCommand({
    files: [transcript],
    writesWhileOpen: true,
    name: "attached-run",
    onChange: () => echo.pump(),
  });

  let child: { kill: (signal: NodeJS.Signals) => void } | null = null;
  let received: string | null = null;
  const relays = RELAYED_SIGNALS.map((signal) => {
    const relay = (): void => {
      // The FIRST signal is the fact the marker records, as the shim's trap
      // does; every one is relayed (a group signal reaches the child too, and
      // its handler exits on the first).
      received ??= signal.slice("SIG".length);
      child?.kill(signal);
    };
    process.on(signal, relay);
    return () => process.off(signal, relay);
  });

  try {
    const result = await spawnToFile(opts.argv, {
      outputPath: transcript,
      cwd: opts.cwd,
      env: {
        ...opts.env,
        [RUN_TERMINAL_ENV]: terminal,
        [RUN_ERROR_ENV]: worktreeArtifacts.runError(
          opts.namespace,
          opts.kindId,
          opts.runId,
        ),
      },
      stdin: "inherit",
      onSpawn: (spawned) => {
        child = spawned;
      },
    });
    const status =
      result.signalCode === null
        ? result.exitCode
        : 128 + signalNumber(result.signalCode);
    writeRunTerminalSync(terminal, { exitCode: status, signalCode: received });
    return status;
  } finally {
    for (const off of relays) off();
    await watcher.stop();
    echo.stop();
  }
}

/** The shell's `128 + signo`, for a child that died of a signal. */
function signalNumber(name: string): number {
  const signo = (constants.signals as Record<string, number | undefined>)[name];
  if (signo === undefined) {
    throw new Error(`[supervised-run] unknown signal ${JSON.stringify(name)}`);
  }
  return signo;
}

/** Copies whatever the transcript gained since the last pump to stdout. */
function createEcho(path: string): { pump(): void; stop(): void } {
  const fd = adoptFd(openSync(path, "r"));
  let offset = 0;
  let open = true;
  const buf = Buffer.alloc(ECHO_CHUNK_BYTES);
  const pump = (): void => {
    if (!open) return;
    const size = fstatSync(fd.fd).size;
    while (offset < size) {
      const n = readSync(fd.fd, buf, 0, buf.length, offset);
      if (n === 0) break;
      writeAll(buf.subarray(0, n));
      offset += n;
    }
  };
  return {
    pump,
    stop: () => {
      pump();
      open = false;
      fd.close();
    },
  };
}

function writeAll(bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(1, bytes, written, bytes.length - written);
  }
}
