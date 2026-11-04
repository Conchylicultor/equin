import {
  defineFileSink,
  type FileSink,
} from "@plugins/infra/plugins/file-sink/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  currentCallerKind,
  currentEntryLabel,
  runTracked,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  logEnvelope,
  logsDirFor,
} from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import {
  onSlowFsCall,
  type SlowFsCall,
} from "@plugins/packages/plugins/timed-fs/core";
import { FS_WAIT_CHANNEL, type FsWaitLine } from "../../core";

// Every process that runs this repo's code — a backend, an exec child, a CLI
// run — writes its slow file calls down the same way, to its namespace's
// `fs-wait` log channel (Debug → Logs reads it; the file is the channel's own
// `<logs>/fs-wait.jsonl`, in the log-channel envelope). One shape wherever a
// disk stall lands — boot, a live read, a build — so lining the files up says
// whether the stalls were one cause or several.
//
// Overlapping slow calls are one episode (see `FsWaitLineSchema`): its first
// call is written synchronously as it returns — a process killed mid-stall
// still left it — and its summary when it closes. Measured on the first build
// that recorded per call: one `./equin check` wrote 17,089 lines, every one a
// readFile queued behind the same pass's thousands of others.
// timed-fs never dispatches the sink's own file calls back here.

interface Episode {
  from: number;
  to: number;
  calls: number;
  layers: Record<string, number>;
  maxConcurrent: number;
  slowest: {
    op: string;
    ms: number;
    target: string | null;
    caller: string | null;
  };
}

let installed: { process: string } | null = null;

/**
 * Write this process's slow file calls (timed-fs's `onSlowFsCall`, past its
 * floor) to `namespace`'s `fs-wait` channel, labelled `process` (`backend`,
 * `exec`, `cli build`). Once per process: a second call with another label
 * throws — one process, one name.
 *
 * `namespace` may still be resolving (a CLI derives its checkout's from git,
 * ~30 ms it should not wait for): lines landing before it are held, then
 * written in order.
 */
export function recordFsWaits(opts: {
  process: string;
  namespace: Namespace | Promise<Namespace>;
}): void {
  if (installed !== null) {
    if (installed.process === opts.process) return;
    throw new Error(
      `[fs-wait] this process already records its file waits as "${installed.process}", not "${opts.process}"`,
    );
  }
  installed = { process: opts.process };
  const common = { process: opts.process, pid: process.pid };

  let sink: FileSink | null = null;
  const held: string[] = [];
  const write = (line: FsWaitLine): void => {
    const entry = logEnvelope({
      t: Date.now(),
      stream: "stdout",
      line: JSON.stringify(line),
    });
    if (sink === null) held.push(entry);
    else sink.append(entry);
  };
  const open = (namespace: Namespace): void => {
    sink = defineFileSink({
      id: FS_WAIT_CHANNEL,
      description:
        "Slow file calls (timed-fs: a read, listing, stat or glob scan past its floor) of every process of this namespace — backend, exec child, CLI run — as episodes of overlapping calls: the first call as it returns, a summary as the episode closes.",
      path: () =>
        joinAppPath(logsDirFor(namespace), `${FS_WAIT_CHANNEL}.jsonl`),
    });
    if (held.length > 0) sink.appendAll(held.splice(0));
  };
  const namespace = opts.namespace;
  if (namespace instanceof Promise) {
    // Rejected → unhandled, on purpose: loud, never a silently unrecorded run.
    void runTracked("fs-wait.namespace", async () => open(await namespace));
  } else open(namespace);

  let episode: Episode | null = null;
  const close = (): void => {
    if (episode !== null && episode.calls > 1)
      write({ kind: "episode", ...common, ...episode });
    episode = null;
  };
  process.once("exit", close);

  onSlowFsCall((call: SlowFsCall) => {
    const kind = currentCallerKind();
    const label = currentEntryLabel();
    const caller =
      kind !== undefined && label !== undefined ? `${kind} ${label}` : null;
    const ms = Math.round(call.ms);
    const start = call.at - ms;
    if (episode !== null && start <= episode.to) {
      episode.to = Math.max(episode.to, call.at);
      episode.calls++;
      episode.layers[call.layer] = (episode.layers[call.layer] ?? 0) + 1;
      episode.maxConcurrent = Math.max(episode.maxConcurrent, call.concurrent);
      if (ms > episode.slowest.ms)
        episode.slowest = { op: call.op, ms, target: call.target, caller };
      return;
    }
    close();
    episode = {
      from: start,
      to: call.at,
      calls: 1,
      layers: { [call.layer]: 1 },
      maxConcurrent: call.concurrent,
      slowest: { op: call.op, ms, target: call.target, caller },
    };
    write({
      kind: "call",
      ...common,
      at: call.at,
      layer: call.layer,
      op: call.op,
      ms,
      target: call.target,
      concurrent: call.concurrent,
      caller,
    });
  });
}
